import {
  ConnectionQuality, DisconnectReason, Room, RoomEvent, Track,
  type RemoteTrackPublication,
} from "livekit-client";
import { audioContext, audioRunning, resumeAudio } from "./audio.ts";
import { SpeakingDetector } from "./speaking.ts";
import { playSound, preloadSounds } from "./sounds.ts";

export type ChannelKind = "text" | "voice";
export interface Channel { id: number; name: string; kind: ChannelKind; }
type AttachmentType = "image" | "file";
interface Message {
  id: number; channel_id: number; author: string; content: string; created_at: string;
  attachment_url?: string; attachment_type?: AttachmentType;
}
interface Attachment { url: string; type: AttachmentType; name: string; }
export interface User { id: number; name: string; }
// identity is the stable user ID; name is the display name to show.
export interface VoiceParticipant { identity: string; name: string; muted: boolean; deafened: boolean; }
// track is null until the viewer opts in to watching; loading covers the gap after they do.
export interface ScreenStream { identity: string; name: string; local: boolean; track: Track | null; loading: boolean; }

// LiveKit has no deafen concept, so each client publishes it as a participant attribute.
const DEAFENED_ATTR = "deafened";

const WS_RECONNECT_BASE = 1_000;  // ms
const WS_RECONNECT_MAX  = 30_000; // ms

// Per-device session state, so a page refresh lands back where the user was.
const CHANNEL_KEY = "gc_channel";
const VOICE_KEY   = "gc_voice";
interface VoicePrefs   { muted: boolean; deafened: boolean; }
interface VoiceSession extends VoicePrefs { channelId: number; }

const REQUEST_TIMEOUT_MS = 10_000;
// livekit-client retries some failures forever (e.g. /rtc answering 404), so a join gets a deadline.
const JOIN_TIMEOUT_MS    = 15_000;
const UPLOAD_TIMEOUT_MS  = 120_000;

// The app, API and LiveKit share one origin (Vite proxies them in development).
function wsUrl(path = "") {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
}

// A stalled server should surface as an error, not an endless load.
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (init.signal?.aborted) ctrl.abort();
  init.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sameParticipants = (a: VoiceParticipant[], b: VoiceParticipant[]) =>
  a.length === b.length
  && a.every((p, i) => p.identity === b[i].identity && p.name === b[i].name
    && p.muted === b[i].muted && p.deafened === b[i].deafened);

const sameStreams = (a: ScreenStream[], b: ScreenStream[]) =>
  a.length === b.length
  && a.every((s, i) => s.identity === b[i].identity && s.track === b[i].track && s.loading === b[i].loading);

class GumcordStore {
  // auth: the session is an HttpOnly cookie, so the server's answer to /me is the only source of truth
  me:        User | null = $state(null);
  signedOut  = $state(false);

  // boot
  bootError = $state("");
  booted    = $state(false);

  // channels + messages
  channels:      Channel[]      = $state([]);
  activeChannel: Channel | null = $state(null);
  messages:      Message[]      = $state([]);
  draft = $state("");
  pendingAttachment: Attachment | null = $state(null);
  uploading   = $state(false);
  uploadError = $state("");

  // Main pane: the selected text channel, or the call view of the connected voice channel.
  mainView: "chat" | "call" = $state("chat");

  // voice
  room:              Room | null          = $state(null);
  voiceChannel:      Channel | null       = $state(null);
  voiceQuality:      ConnectionQuality    = $state(ConnectionQuality.Unknown);
  voiceMuted                              = $state(false);
  voiceDeafened                           = $state(false);
  // Mic permission denied or no input device: user can listen but stays muted.
  micBlocked                              = $state(false);
  // Autoplay policy blocked playback (e.g. auto-rejoin after a refresh); needs a user gesture.
  audioBlocked                            = $state(false);
  // Raw: rebuilt wholesale (and only on real change); streams hold LiveKit class instances that must not be proxied.
  voiceParticipants: VoiceParticipant[]   = $state.raw([]);
  streams:           ScreenStream[]       = $state.raw([]);
  // Kept apart from voiceParticipants so a speaking tick doesn't re-render every row.
  speaking:          ReadonlySet<string>  = $state.raw(new Set());
  screenSharing                           = $derived(this.streams.some((s) => s.local));
  readonly canScreenShare                 = typeof navigator.mediaDevices?.getDisplayMedia === "function";

  // The user's own mute choice, independent of deafen and mic-permission failures.
  #wantMuted        = false;
  #joining          = false;
  #audioResumeArmed = false;
  // Local level detection drives the speaking ring; the server's slower updates are the fallback.
  #speakingDetector = new SpeakingDetector(() => this.#refreshSpeaking());
  #serverSpeaking   = new Set<string>();

  // private
  #ws:           WebSocket | null              = null;
  #wsRetries     = 0;
  #wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #audioEls:     Map<string, HTMLAudioElement> = new Map();
  #fetchAbort:   AbortController | null        = null;

  // Labels shared by the sidebar and call-view controls.
  get muteLabel() {
    return this.micBlocked ? "Microphone unavailable. Check permissions" : this.voiceMuted ? "Unmute" : "Mute";
  }

  get deafenLabel() {
    return this.voiceDeafened ? "Undeafen" : "Deafen";
  }

  get shareLabel() {
    if (!this.canScreenShare) return "Screen sharing isn't supported in this window";
    return this.screenSharing ? "Stop sharing" : "Share your screen";
  }

  // API request with a timeout. A 401 means the session ended, which drops back to the login screen.
  async #api(path: string, init: RequestInit = {}, ms?: number) {
    const res = await fetchWithTimeout(`/api${path}`, init, ms);
    if (res.status === 401 && this.me) void this.#endSession();
    return res;
  }

  // ── Auth ──────────────────────────────────────────────────

  async logout() {
    await fetchWithTimeout("/api/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem(CHANNEL_KEY);
    localStorage.removeItem(VOICE_KEY);
    await this.#endSession();
  }

  async #endSession() {
    clearTimeout(this.#wsRetryTimer ?? undefined);
    this.#wsRetryTimer = null;
    this.#wsRetries    = 0;
    this.me            = null; // before closing the socket, so it doesn't reconnect
    // Leave without clearing the saved voice session, so signing back in rejoins.
    await this.room?.disconnect();
    this.#ws?.close();
    this.#ws           = null;
    this.channels      = [];
    this.messages      = [];
    this.activeChannel = null;
    this.bootError     = "";
    this.booted        = false;
    this.signedOut     = true;
  }

  // ── Boot ──────────────────────────────────────────────────

  async boot() {
    this.bootError = "";
    try {
      await this.#boot();
    } catch (err) {
      // Anything unexpected must land on the error screen, never leave the splash up forever.
      console.error("Boot failed:", err);
      this.bootError = `Couldn't load Gumcord: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async #boot() {
    let me: Response, channels: Response;
    try {
      [me, channels] = await Promise.all([this.#api("/me"), this.#api("/channels")]);
    } catch {
      this.bootError = "Cannot reach server. Is the backend running?";
      return;
    }
    if (me.status === 401) { this.signedOut = true; return; }
    if (!me.ok || !channels.ok) { this.bootError = `Server error (${me.ok ? channels.status : me.status}).`; return; }

    this.me        = await me.json();
    this.signedOut = false;
    this.channels  = await channels.json();
    const savedId = Number(localStorage.getItem(CHANNEL_KEY));
    const text = this.channels.find((c) => c.kind === "text" && c.id === savedId)
              ?? this.channels.find((c) => c.kind === "text");
    // Everything below only needs the channel list, so it runs while the messages load.
    const messages = text ? this.selectChannel(text) : undefined;
    void preloadSounds();
    this.#openWS();
    this.#restoreVoice();
    await messages;
    this.booted = true;
  }

  #restoreVoice() {
    const saved = this.#loadVoiceSession();
    if (!saved) return;
    const ch = this.channels.find((c) => c.id === saved.channelId && c.kind === "voice");
    if (!ch) { localStorage.removeItem(VOICE_KEY); return; }
    // Not awaited: the app shouldn't wait on LiveKit before it's usable.
    void this.joinVoice(ch, saved);
  }

  #loadVoiceSession(): VoiceSession | null {
    try {
      const s = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null");
      return s && typeof s.channelId === "number" ? s : null;
    } catch {
      return null;
    }
  }

  #voicePrefs(): VoicePrefs {
    return { muted: this.#wantMuted, deafened: this.voiceDeafened };
  }

  #saveVoiceSession() {
    if (!this.voiceChannel) return;
    const session: VoiceSession = { channelId: this.voiceChannel.id, ...this.#voicePrefs() };
    localStorage.setItem(VOICE_KEY, JSON.stringify(session));
  }

  destroy() {
    clearTimeout(this.#wsRetryTimer ?? undefined);
    this.#ws?.close();
    this.room?.disconnect();
  }

  // ── Channels / messages ───────────────────────────────────

  async selectChannel(ch: Channel) {
    if (ch.kind === "voice") return;

    // Cancel any in-flight fetch for a previous channel
    this.#fetchAbort?.abort();
    this.#fetchAbort = new AbortController();
    this.activeChannel     = ch;
    this.mainView          = "chat";
    this.pendingAttachment = null;
    this.uploadError       = "";
    localStorage.setItem(CHANNEL_KEY, String(ch.id));

    try {
      const res = await this.#api(`/channels/${ch.id}/messages`, { signal: this.#fetchAbort.signal });
      this.messages = res.ok ? await res.json() : [];
    } catch (err) {
      if ((err as Error).name !== "AbortError") this.messages = [];
    }
  }

  async createChannel(name: string, kind: ChannelKind) {
    const res = await this.#api("/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, kind }),
    });
    if (!res.ok) return;
    const ch: Channel = await res.json();
    this.channels = [...this.channels, ch];
  }

  async uploadFile(file: File) {
    this.uploadError = "";
    this.uploading   = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await this.#api("/upload", { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
      if (!res.ok) {
        this.uploadError = res.status === 413 ? "File too large (max 25 MB)." : "Upload failed.";
        return;
      }
      this.pendingAttachment = await res.json();
    } catch {
      this.uploadError = "Upload failed.";
    } finally {
      this.uploading = false;
    }
  }

  sendMessage() {
    const content = this.draft.trim();
    const att     = this.pendingAttachment;
    if (!content && !att) return;
    if (!this.activeChannel || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify({
      channel_id:      this.activeChannel.id,
      content,
      attachment_url:  att?.url  ?? "",
      attachment_type: att?.type ?? "",
    }));
    this.draft             = "";
    this.pendingAttachment = null;
  }

  // ── WebSocket ─────────────────────────────────────────────

  #openWS() {
    if (this.#ws || !this.me) return;
    this.#ws = new WebSocket(wsUrl("/api/ws"));
    let opened = false;

    this.#ws.onopen = () => {
      opened = true;
      this.#wsRetries = 0; // successful connection resets backoff
    };

    this.#ws.onmessage = (e) => {
      let msg: Message;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (this.activeChannel && msg.channel_id === this.activeChannel.id) {
        this.messages = [...this.messages, msg];
      }
    };

    this.#ws.onclose = () => {
      this.#ws = null;
      if (!this.me) return; // signed out: don't reconnect
      // A refused handshake may be an expired session; #api signs out if so.
      if (!opened) void this.#api("/me").catch(() => {});
      const delay = Math.min(WS_RECONNECT_BASE * 2 ** this.#wsRetries, WS_RECONNECT_MAX);
      this.#wsRetries++;
      this.#wsRetryTimer = setTimeout(() => this.#openWS(), delay);
    };
  }

  // ── Voice ─────────────────────────────────────────────────

  // Clicking a voice channel: join it, open its call view if already in it, or switch to it.
  async openVoiceChannel(ch: Channel) {
    if (this.voiceChannel?.id === ch.id) {
      this.mainView = "call";
      return;
    }
    if (!this.room) return this.joinVoice(ch);
    // Switching keeps mute/deafen and stays in the call view if that's where the user was.
    const prefs = this.#voicePrefs();
    const inCallView = this.mainView === "call";
    await this.leaveVoice();
    await this.joinVoice(ch, prefs);
    if (inCallView && this.room) this.mainView = "call";
  }

  async joinVoice(ch: Channel, prefs: Partial<VoicePrefs> = {}) {
    // Guard against a click racing the auto-rejoin and opening two rooms.
    if (this.room || this.#joining) return;
    this.#joining = true;
    try {
      await this.#connectVoice(ch, prefs);
    } catch (err) {
      console.warn("Couldn't join voice:", err);
    } finally {
      this.#joining = false;
    }
  }

  async #connectVoice(ch: Channel, prefs: Partial<VoicePrefs>) {
    const res = await this.#api("/voice/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: ch.id }),
    });
    if (!res.ok) return;
    const { token: lkToken } = await res.json();

    // Only pull the video resolution each tile actually displays, and stop sending unwatched layers.
    const r = new Room({ adaptiveStream: true, dynacast: true });

    // Discord has separate join/leave sounds for other people; connect/disconnect stand in for them.
    r.on(RoomEvent.ParticipantConnected, () => {
      playSound("connect");
      this.#updateParticipants(r);
    });
    r.on(RoomEvent.ParticipantDisconnected, () => {
      playSound("disconnect");
      this.#updateParticipants(r);
    });

    r.on(RoomEvent.TrackPublished, (pub) => {
      this.#autoSubscribe(pub);
      this.#updateParticipants(r);
    });

    r.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        const el  = track.attach();
        el.muted  = this.voiceDeafened;
        const sid = track.sid ?? track.source;
        this.#audioEls.set(sid, el);
        document.body.appendChild(el);
        if (pub.source === Track.Source.Microphone) {
          this.#speakingDetector.watch(participant.identity, track.mediaStreamTrack);
        }
      }
      this.#updateParticipants(r);
    });

    r.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        track.detach();
        const sid = track.sid ?? track.source;
        this.#audioEls.get(sid)?.remove();
        this.#audioEls.delete(sid);
        if (pub.source === Track.Source.Microphone) this.#speakingDetector.unwatch(participant.identity);
      }
      this.#updateParticipants(r);
    });

    r.on(RoomEvent.LocalTrackPublished, (pub, participant) => {
      if (pub.source === Track.Source.Microphone && pub.track) {
        this.#speakingDetector.watch(participant.identity, pub.track.mediaStreamTrack);
      }
      this.#updateParticipants(r);
    });

    // Also fires when the browser's own "Stop sharing" button ends a screen share.
    r.on(RoomEvent.LocalTrackUnpublished, (pub, participant) => {
      if (pub.source === Track.Source.Microphone) this.#speakingDetector.unwatch(participant.identity);
      this.#updateParticipants(r);
    });

    // Keep everyone's mute/deafen indicators current.
    for (const ev of [
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackUnpublished,
      RoomEvent.ParticipantAttributesChanged,
    ] as const) {
      r.on(ev, () => this.#updateParticipants(r));
    }

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this.#serverSpeaking = new Set(speakers.map((p) => p.identity));
      this.#refreshSpeaking();
    });

    r.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) this.voiceQuality = quality;
    });

    r.on(RoomEvent.AudioPlaybackStatusChanged, () => this.#syncAudioPlayback(r));

    // Disconnects we didn't ask for (page unload, network drop) keep the saved session so a refresh rejoins.
    r.on(RoomEvent.Disconnected, (reason) => {
      // Our own leave plays its sound in leaveVoice; page unloads are client-initiated too and stay silent.
      // A join that never connected (this.room isn't set yet) isn't a disconnect either.
      if (this.room === r && reason !== DisconnectReason.CLIENT_INITIATED) playSound("disconnect");
      this.#resetVoice();
    });

    // Set before connecting so tracks subscribed during connect are attached already muted.
    this.voiceDeafened = prefs.deafened ?? false;
    audioContext();
    // Disconnecting while connecting cancels the attempt and rejects connect().
    const giveUp = setTimeout(() => void r.disconnect(), JOIN_TIMEOUT_MS);
    try {
      // Manual subscriptions: voice is always received, screen shares only once someone chooses to watch.
      // LiveKit signalling is routed under /rtc on this same origin.
      await r.connect(wsUrl(), lkToken, { autoSubscribe: false });
    } catch (err) {
      this.voiceDeafened = false;
      throw err;
    } finally {
      clearTimeout(giveUp);
    }
    this.room         = r;
    this.voiceChannel = ch;
    for (const p of r.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) this.#autoSubscribe(pub);
    }
    playSound("connect");
    this.#syncAudioPlayback(r);

    this.#wantMuted = prefs.muted ?? false;
    if (this.#wantMuted || this.voiceDeafened) this.voiceMuted = true;
    else await this.#setMic(true);
    if (this.voiceDeafened) this.#publishDeafened();
    this.#updateParticipants(r);
    this.#saveVoiceSession();
  }

  #publishDeafened() {
    this.room?.localParticipant
      .setAttributes({ [DEAFENED_ATTR]: this.voiceDeafened ? "1" : "" })
      .catch((err) => console.warn("Couldn't publish deafen state:", err));
  }

  #syncAudioPlayback(r: Room) {
    this.audioBlocked = !r.canPlaybackAudio;
    // A suspended shared context doesn't block hearing anyone, so it doesn't set audioBlocked.
    if (this.audioBlocked || !audioRunning()) this.#armAudioResume();
  }

  // Autoplay needs a user gesture, so the first click or key press anywhere resumes playback.
  #armAudioResume() {
    if (this.#audioResumeArmed) return;
    this.#audioResumeArmed = true;
    const resume = () => {
      document.removeEventListener("pointerdown", resume, true);
      document.removeEventListener("keydown", resume, true);
      this.#audioResumeArmed = false;
      void this.enableAudio();
    };
    document.addEventListener("pointerdown", resume, true);
    document.addEventListener("keydown", resume, true);
  }

  async enableAudio() {
    const r = this.room;
    if (!r) return;
    try {
      await Promise.all([r.startAudio(), resumeAudio()]);
    } catch {
      // Still blocked; #syncAudioPlayback re-arms below.
    }
    this.#refreshSpeaking();
    this.#syncAudioPlayback(r);
  }

  async leaveVoice() {
    localStorage.removeItem(VOICE_KEY);
    if (!this.room) return;
    playSound("disconnect");
    await this.room.disconnect();
    this.#resetVoice();
  }

  // Idempotent: runs from leaveVoice and again from the Disconnected event.
  #resetVoice() {
    this.#audioEls.forEach((el) => el.remove());
    this.#audioEls.clear();
    this.#speakingDetector.clear();
    this.#serverSpeaking   = new Set();
    this.#wantMuted        = false;
    this.mainView          = "chat";
    this.room              = null;
    this.voiceChannel      = null;
    this.voiceMuted        = false;
    this.micBlocked        = false;
    this.voiceDeafened     = false;
    this.audioBlocked      = false;
    this.voiceQuality      = ConnectionQuality.Unknown;
    this.voiceParticipants = [];
    this.streams           = [];
    this.speaking          = new Set();
  }

  async toggleDeafen() {
    if (!this.room) return;
    if (!this.voiceDeafened) {
      playSound("deafen");
      this.#setIncomingAudio(false);
      if (!this.voiceMuted) await this.#setMic(false);
    } else {
      playSound("undeafen");
      this.#setIncomingAudio(true);
      if (!this.#wantMuted) await this.#setMic(true);
    }
    this.#saveVoiceSession();
  }

  #setIncomingAudio(on: boolean) {
    this.voiceDeafened = !on;
    this.#audioEls.forEach((el) => (el.muted = !on));
    this.#publishDeafened();
    this.#updateParticipants(this.room);
  }

  async #setMic(on: boolean) {
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(on);
      this.voiceMuted = !on;
      if (on) this.micBlocked = false;
    } catch {
      this.micBlocked = true;
      this.voiceMuted = true;
    }
    this.#updateParticipants(this.room);
  }

  async toggleMute() {
    if (!this.room) return;
    const unmute = this.voiceMuted;
    // Unmuting while deafened undeafens too, like Discord.
    const undeafen = unmute && this.voiceDeafened;
    this.#wantMuted = !unmute;
    if (undeafen) this.#setIncomingAudio(true);
    // Retrying on unmute lets it recover if the user grants permission later.
    await this.#setMic(unmute);
    if (undeafen) playSound("undeafen");
    else if (!unmute) playSound("mute");
    else if (!this.voiceMuted) playSound("unmute"); // silent if the mic still couldn't be opened
    this.#saveVoiceSession();
  }

  #autoSubscribe(pub: RemoteTrackPublication) {
    if (pub.source === Track.Source.Microphone) pub.setSubscribed(true);
  }

  // A share's video and its audio are watched (and downloaded) together.
  #screenPublications(identity: string) {
    const p = this.room?.remoteParticipants.get(identity);
    return [p?.getTrackPublication(Track.Source.ScreenShare), p?.getTrackPublication(Track.Source.ScreenShareAudio)];
  }

  watchStream(identity: string) {
    for (const pub of this.#screenPublications(identity)) pub?.setSubscribed(true);
    this.#updateStreams(this.room);
  }

  stopWatching(identity: string) {
    for (const pub of this.#screenPublications(identity)) pub?.setSubscribed(false);
    this.#updateStreams(this.room);
  }

  // Starting a share also opens the call view, so you can see what you're sharing.
  async toggleScreenShare() {
    if (!this.room || !this.canScreenShare) return;
    const on = !this.screenSharing;
    if (on) this.mainView = "call";
    try {
      await this.room.localParticipant.setScreenShareEnabled(
        on,
        // Include tab/system audio where the browser offers it; hide Gumcord's own tab to avoid a mirror loop.
        on ? { audio: true, systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "include" } : undefined,
      );
    } catch (err) {
      // Closing the picker rejects with NotAllowedError: a cancel, not a failure.
      if ((err as Error).name !== "NotAllowedError") console.warn("Screen share failed:", err);
    }
    this.#updateStreams(this.room);
  }

  #refreshSpeaking() {
    this.speaking = audioRunning() ? this.#speakingDetector.speaking : this.#serverSpeaking;
  }

  #updateParticipants(r: Room | null) {
    if (!r) return;
    const local = r.localParticipant;
    const next: VoiceParticipant[] = [
      // Local state comes from the store so it updates before LiveKit round-trips.
      { identity: local.identity, name: local.name || local.identity, muted: this.voiceMuted, deafened: this.voiceDeafened },
      ...Array.from(r.remoteParticipants.values(), (p) => ({
        identity: p.identity,
        name:     p.name || p.identity,
        // No published mic (never enabled, or permission denied) also counts as muted.
        muted:    !p.isMicrophoneEnabled,
        deafened: p.attributes[DEAFENED_ATTR] === "1",
      })),
    ];
    if (!sameParticipants(next, this.voiceParticipants)) this.voiceParticipants = next;
    this.#updateStreams(r);
  }

  #updateStreams(r: Room | null) {
    if (!r) return;
    const next: ScreenStream[] = [];
    const local = r.localParticipant;
    const localShare = local.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (localShare) next.push({ identity: local.identity, name: local.name || local.identity, local: true, track: localShare, loading: false });
    for (const p of r.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      if (!pub) continue;
      const track = pub.isSubscribed ? (pub.track ?? null) : null;
      next.push({ identity: p.identity, name: p.name || p.identity, local: false, track, loading: pub.isDesired && !track });
    }
    // Only replace on a real change, so video elements aren't re-rendered on every event.
    if (!sameStreams(next, this.streams)) this.streams = next;
  }
}

export const store = new GumcordStore();
