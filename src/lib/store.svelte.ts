import { ConnectionQuality, Room, RoomEvent, Track, type RoomOptions } from "livekit-client";
import { API_BASE, LIVEKIT_WS } from "./config.js";
import { SpeakingDetector } from "./speaking.ts";

// rtcConfig is valid at runtime but missing from the SDK's exported types
type RoomOptionsWithRtc = RoomOptions & { rtcConfig?: RTCConfiguration };

interface Channel          { id: number; name: string; kind: string; }
type AttachmentType = "image" | "file";
interface Message {
  id: number; channel_id: number; username: string; content: string; created_at: string;
  attachment_url?: string; attachment_type?: AttachmentType;
}
interface Attachment { url: string; type: AttachmentType; name: string; }
interface VoiceParticipant { identity: string; speaking: boolean; muted: boolean; deafened: boolean; }

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

class GumcordStore {
  // auth
  token      = $state(localStorage.getItem("gc_token") ?? "");
  username   = $state(localStorage.getItem("gc_username") ?? "");
  loginError = $state("");
  loginInput = $state("");
  passInput  = $state("");

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

  // voice
  room:              Room | null          = $state(null);
  voiceMuted                              = $state(false);
  voiceParticipants: VoiceParticipant[]   = $state([]);
  voiceChannel:      Channel | null       = $state(null);
  voiceQuality:      ConnectionQuality    = $state(ConnectionQuality.Unknown);
  // Mic permission denied or no input device: user can listen but stays muted.
  micBlocked                              = $state(false);
  voiceDeafened                           = $state(false);
  // Autoplay policy blocked playback (e.g. auto-rejoin after a refresh); needs a user gesture.
  audioBlocked                            = $state(false);
  // The user's own mute choice, independent of deafen and mic-permission failures.
  #wantMuted                              = false;
  #joining                                = false;
  #audioResumeArmed                       = false;
  // Local level detection drives the speaking ring; the server's slower updates are the fallback.
  #speakingDetector                       = new SpeakingDetector(() => this.#refreshSpeaking());
  #serverSpeaking                         = new Set<string>();

  // private
  #ws:           WebSocket | null              = null;
  #wsRetries     = 0;
  #wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #audioEls:     Map<string, HTMLAudioElement> = new Map();
  #fetchAbort:   AbortController | null        = null;

  // ── Auth ──────────────────────────────────────────────────

  async login() {
    this.loginError = "";
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: this.loginInput, password: this.passInput }),
      });
    } catch {
      this.loginError = "Cannot reach server.";
      return;
    }
    if (!res.ok) { this.loginError = "Wrong password."; return; }

    const data = await res.json();
    this.token    = data.token;
    this.username = this.loginInput;
    localStorage.setItem("gc_token",    this.token);
    localStorage.setItem("gc_username", this.username);
    await this.boot();
  }

  async logout() {
    clearTimeout(this.#wsRetryTimer ?? undefined);
    this.#wsRetryTimer = null;
    this.#wsRetries    = 0;
    await this.leaveVoice();
    this.#ws?.close();
    this.#ws           = null;
    this.token         = "";
    this.username      = "";
    this.channels      = [];
    this.messages      = [];
    this.activeChannel = null;
    this.bootError     = "";
    this.booted        = false;
    localStorage.removeItem("gc_token");
    localStorage.removeItem("gc_username");
    localStorage.removeItem(CHANNEL_KEY);
    localStorage.removeItem(VOICE_KEY);
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
    let res: Response;
    try {
      res = await fetchWithTimeout(`${API_BASE}/channels`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch {
      this.bootError = "Cannot reach server. Is the backend running?";
      return;
    }
    if (res.status === 401) { await this.logout(); return; }
    if (!res.ok) { this.bootError = `Server error (${res.status}).`; return; }

    this.channels = await res.json();
    const savedId = Number(localStorage.getItem(CHANNEL_KEY));
    const text = this.channels.find((c) => c.kind === "text" && c.id === savedId)
              ?? this.channels.find((c) => c.kind === "text");
    if (text) await this.selectChannel(text);
    this.#openWS();
    this.booted = true;
    this.#restoreVoice();
  }

  #restoreVoice() {
    const saved = this.#loadVoiceSession();
    if (!saved) return;
    const ch = this.channels.find((c) => c.id === saved.channelId && c.kind === "voice");
    if (!ch) { localStorage.removeItem(VOICE_KEY); return; }
    // Not awaited: the app shouldn't wait on LiveKit before it's usable.
    this.joinVoice(ch, saved).catch((err) => console.warn("Voice auto-rejoin failed:", err));
  }

  #loadVoiceSession(): VoiceSession | null {
    try {
      const s = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null");
      return s && typeof s.channelId === "number" ? s : null;
    } catch {
      return null;
    }
  }

  #saveVoiceSession() {
    if (!this.voiceChannel) return;
    const session: VoiceSession = {
      channelId: this.voiceChannel.id,
      muted:     this.#wantMuted,
      deafened:  this.voiceDeafened,
    };
    localStorage.setItem(VOICE_KEY, JSON.stringify(session));
  }

  destroy() {
    clearTimeout(this.#wsRetryTimer ?? undefined);
    this.#ws?.close();
    this.#audioEls.forEach((el) => el.remove());
    this.#audioEls.clear();
    this.room?.disconnect();
    this.#speakingDetector.dispose();
  }

  // ── Channels / messages ───────────────────────────────────

  async selectChannel(ch: Channel) {
    if (ch.kind === "voice") return;

    // Cancel any in-flight fetch for a previous channel
    this.#fetchAbort?.abort();
    this.#fetchAbort = new AbortController();
    this.activeChannel     = ch;
    this.pendingAttachment = null;
    this.uploadError       = "";
    localStorage.setItem(CHANNEL_KEY, String(ch.id));

    try {
      const res = await fetchWithTimeout(`${API_BASE}/channels/${ch.id}/messages`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: this.#fetchAbort.signal,
      });
      this.messages = res.ok ? await res.json() : [];
    } catch (err) {
      if ((err as Error).name !== "AbortError") this.messages = [];
    }
  }

  async createChannel(name: string, kind: 'text' | 'voice') {
    const res = await fetch(`${API_BASE}/channels`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
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
      const res = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
        body: form,
      });
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
    if (this.#ws || !this.token) return;
    this.#ws = new WebSocket(`${API_BASE.replace("http", "ws")}/ws?token=${this.token}`);

    this.#ws.onopen = () => {
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
      if (!this.token) return; // logged out — don't reconnect
      const delay = Math.min(WS_RECONNECT_BASE * 2 ** this.#wsRetries, WS_RECONNECT_MAX);
      this.#wsRetries++;
      this.#wsRetryTimer = setTimeout(() => this.#openWS(), delay);
    };
  }

  // ── Voice ─────────────────────────────────────────────────

  async joinVoice(ch: Channel, prefs: Partial<VoicePrefs> = {}) {
    // Guard against a click racing the auto-rejoin and opening two rooms.
    if (this.room || this.#joining) return;
    this.#joining = true;
    try {
      await this.#connectVoice(ch, prefs);
    } finally {
      this.#joining = false;
    }
  }

  async #connectVoice(ch: Channel, prefs: Partial<VoicePrefs>) {
    const res = await fetch(`${API_BASE}/voice/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ room: ch.name }),
    });
    if (!res.ok) return;
    const { token: lkToken } = await res.json();

    const r = new Room({
      rtcConfig: {
        iceServers: [{
          urls: `turn:${new URL(API_BASE).hostname}:3478?transport=tcp`,
          username: "livekit",
          credential: "turnpass",
        }],
      },
    } as RoomOptionsWithRtc);

    r.on(RoomEvent.ParticipantConnected,    () => this.#updateParticipants(r));
    r.on(RoomEvent.ParticipantDisconnected, () => this.#updateParticipants(r));

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
    });

    r.on(RoomEvent.LocalTrackUnpublished, (pub, participant) => {
      if (pub.source === Track.Source.Microphone) this.#speakingDetector.unwatch(participant.identity);
    });

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this.#serverSpeaking = new Set(speakers.map((p) => p.identity));
      this.#refreshSpeaking();
    });

    r.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) this.voiceQuality = quality;
    });

    r.on(RoomEvent.AudioPlaybackStatusChanged, () => this.#syncAudioPlayback(r));

    // Keep everyone's mute/deafen indicators current.
    for (const ev of [
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.ParticipantAttributesChanged,
    ] as const) {
      r.on(ev, () => this.#updateParticipants(r));
    }

    // Disconnects we didn't ask for (page unload, network drop) keep the saved session so a refresh rejoins.
    r.on(RoomEvent.Disconnected, () => {
      this.#audioEls.forEach((el) => el.remove());
      this.#audioEls.clear();
      this.#resetVoice();
    });

    // Set before connecting so tracks subscribed during connect are attached already muted.
    this.voiceDeafened = prefs.deafened ?? false;
    this.#speakingDetector.prepare();
    try {
      await r.connect(LIVEKIT_WS, lkToken);
    } catch (err) {
      this.voiceDeafened = false;
      throw err;
    }
    this.room         = r;
    this.voiceChannel = ch;
    this.#updateParticipants(r);
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
    // A suspended level-detection context doesn't block hearing anyone, so it doesn't set audioBlocked.
    if (this.audioBlocked || !this.#speakingDetector.running) this.#armAudioResume();
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
      await Promise.all([r.startAudio(), this.#speakingDetector.resume()]);
    } catch {
      // Still blocked; #syncAudioPlayback re-arms below.
    }
    this.#syncAudioPlayback(r);
  }

  async leaveVoice() {
    localStorage.removeItem(VOICE_KEY);
    if (!this.room) return;
    this.#audioEls.forEach((el) => el.remove());
    this.#audioEls.clear();
    await this.room.disconnect();
    this.#resetVoice();
  }

  #resetVoice() {
    this.room              = null;
    this.voiceChannel      = null;
    this.voiceMuted        = false;
    this.micBlocked        = false;
    this.voiceDeafened     = false;
    this.audioBlocked      = false;
    this.voiceQuality      = ConnectionQuality.Unknown;
    this.voiceParticipants = [];
    this.#wantMuted        = false;
    this.#serverSpeaking   = new Set();
    this.#speakingDetector.clear();
  }

  async toggleDeafen() {
    if (!this.room) return;
    if (!this.voiceDeafened) {
      this.#setIncomingAudio(false);
      if (!this.voiceMuted) await this.#setMic(false);
    } else {
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
    this.#wantMuted = !unmute;
    // Unmuting while deafened undeafens too, like Discord.
    if (unmute && this.voiceDeafened) this.#setIncomingAudio(true);
    // Retrying on unmute lets it recover if the user grants permission later.
    await this.#setMic(unmute);
    this.#saveVoiceSession();
  }

  #speakingNow(): ReadonlySet<string> {
    return this.#speakingDetector.running ? this.#speakingDetector.speaking : this.#serverSpeaking;
  }

  #refreshSpeaking() {
    const speaking = this.#speakingNow();
    if (this.voiceParticipants.every((p) => p.speaking === speaking.has(p.identity))) return;
    this.voiceParticipants = this.voiceParticipants.map((p) => ({ ...p, speaking: speaking.has(p.identity) }));
  }

  #updateParticipants(r: Room | null) {
    if (!r) return;
    const speaking = this.#speakingNow();
    const local = r.localParticipant;
    this.voiceParticipants = [
      // Local state comes from the store so it updates before LiveKit round-trips.
      { identity: local.identity, speaking: speaking.has(local.identity), muted: this.voiceMuted, deafened: this.voiceDeafened },
      ...Array.from(r.remoteParticipants.values(), (p) => ({
        identity: p.identity,
        speaking: speaking.has(p.identity),
        // No published mic (never enabled, or permission denied) also counts as muted.
        muted:    !p.isMicrophoneEnabled,
        deafened: p.attributes[DEAFENED_ATTR] === "1",
      })),
    ];
  }
}

export const store = new GumcordStore();
