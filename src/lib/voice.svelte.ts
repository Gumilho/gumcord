// The voice call: joining and leaving, your microphone, who's in the call and their screen shares,
// and the settings that change how you sound (devices, noise suppression, push-to-talk).
import {
  ConnectionQuality, DisconnectReason, Room, RoomEvent, Track,
  type RemoteParticipant, type RemoteTrackPublication,
} from "livekit-client";
import { audioContext, audioRunning, resumeAudio, setOutputDevice } from "./audio.ts";
import { t } from "./i18n.svelte.ts";
import { wsUrl } from "./net.ts";
import { canSuppressNoise, NoiseFilter } from "./noise.ts";
import { prefs, type AudioDeviceKind, type KeybindPrefs, type NoiseSuppression } from "./prefs.svelte.ts";
import { servers } from "./servers.svelte.ts";
import { session } from "./session.svelte.ts";
import { playSound } from "./sounds.ts";
import { SpeakingDetector } from "./speaking.ts";
import { ui } from "./ui.svelte.ts";
import { userAudio } from "./userAudio.svelte.ts";
import type { Channel, ScreenStream, VoiceMember, VoiceParticipant } from "./types.ts";
import {
  avatarOf, hideSelfIfJustLeft, JUST_LEFT_MS, parseRooms, sameParticipants, sameStreams, type JustLeft,
} from "./voice-util.ts";

// LiveKit has no deafen concept, so each client publishes it as a participant attribute.
const DEAFENED_ATTR = "deafened";

// Holding push-to-talk a moment after release keeps the ends of words.
const PTT_RELEASE_MS = 150;

// Per-device session state, so a page refresh rejoins the call.
export const VOICE_KEY = "gc_voice";
interface VoicePrefs   { muted: boolean; deafened: boolean; }
// The whole channel, not just its ID: the call may be in a server other than the one on screen.
interface VoiceSession extends VoicePrefs { channel: Channel; }

// livekit-client retries some failures forever (e.g. /rtc answering 404), so a join gets a deadline.
const JOIN_TIMEOUT_MS = 15_000;

class Voice {
  room:         Room | null       = $state(null);
  channel:      Channel | null    = $state(null);
  quality:      ConnectionQuality = $state(ConnectionQuality.Unknown);
  muted                           = $state(false);
  deafened                        = $state(false);
  // Mic permission denied or no input device: user can listen but stays muted.
  micBlocked                      = $state(false);
  // Autoplay policy blocked playback (e.g. auto-rejoin after a refresh); needs a user gesture.
  audioBlocked                    = $state(false);
  // Raw: rebuilt wholesale (and only on real change); streams hold LiveKit class instances that must not be proxied.
  participants: VoiceParticipant[] = $state.raw([]);
  streams:      ScreenStream[]     = $state.raw([]);
  // Kept apart from participants so a speaking tick doesn't re-render every row.
  speaking:     ReadonlySet<string> = $state.raw(new Set());
  // Who is in each voice channel (by channel ID), pushed by the server. Replaced wholesale on change.
  rooms:        ReadonlyMap<number, VoiceMember[]> = $state.raw(new Map());
  screenSharing                   = $derived(this.streams.some((s) => s.local));
  readonly canScreenShare         = typeof navigator.mediaDevices?.getDisplayMedia === "function";

  // The user's own mute choice, independent of deafen and mic-permission failures.
  #wantMuted        = false;
  // The join under way, if any: a click during the auto-rejoin waits for it instead of opening a second room.
  #joining: Promise<void> | null = null;
  #audioResumeArmed = false;
  // Local level detection drives the speaking ring; the server's slower updates are the fallback.
  #speakingDetector = new SpeakingDetector(() => this.#refreshSpeaking());
  #serverSpeaking   = new Set<string>();
  #audioEls         = new Map<string, HTMLAudioElement>();
  // Push-to-talk key held (or within the release delay).
  #pttHeld = false;
  #pttRelease: ReturnType<typeof setTimeout> | undefined;
  // The channel you just left, where you're hidden until the server's list catches up.
  #justLeft: JustLeft | null = null;
  // Noise filter changes run one at a time, each against the latest setting.
  #noiseFilterSync: Promise<void> = Promise.resolve();
  // One listener however often it's added: the audio starting (or stopping) puts the filter on (or off).
  #onAudioState = () => void this.#syncNoiseFilter();

  // Other parts of the app that live and die with the call (the soundboard) hook in here.
  #joinedHooks: (() => void)[] = [];
  #leftHooks:   (() => void)[] = [];
  #dataHandlers = new Map<string, (identity: string, payload: Uint8Array) => void>();

  constructor() {
    // A changed volume or mute takes effect in the call at once.
    userAudio.onChange = (identity) => {
      const p = this.room?.remoteParticipants.get(identity);
      if (p) this.#applyUserAudio(p);
    };
  }

  onJoined(fn: () => void) { this.#joinedHooks.push(fn); }
  onLeft(fn: () => void) { this.#leftHooks.push(fn); }
  // Data messages other participants send into the call, by topic.
  onData(topic: string, fn: (identity: string, payload: Uint8Array) => void) { this.#dataHandlers.set(topic, fn); }

  // Labels shared by the sidebar and call-view controls.
  get muteLabel() {
    return t(this.micBlocked ? "Microphone unavailable. Check permissions" : this.muted ? "Unmute" : "Mute");
  }

  get deafenLabel() {
    return t(this.deafened ? "Undeafen" : "Deafen");
  }

  get shareLabel() {
    if (!this.canScreenShare) return t("Screen sharing isn't supported in this window");
    return t(this.screenSharing ? "Stop sharing" : "Share your screen");
  }

  // The server the current call is in, which may not be the one on screen.
  get server() {
    return servers.list.find((s) => s.id === this.channel?.server_id) ?? null;
  }

  // ── Who's in each channel ─────────────────────────────────

  setRooms(channels: Record<string, VoiceMember[]>) {
    this.rooms = this.#hideSelf(parseRooms(channels), true);
  }

  // Hides you from the channel you just left until a server update no longer lists you there.
  #hideSelf(rooms: ReadonlyMap<number, VoiceMember[]>, fromServer: boolean) {
    const out = hideSelfIfJustLeft(rooms, this.#justLeft, String(session.me?.id), fromServer);
    this.#justLeft = out.left;
    return out.rooms;
  }

  // ── Joining and leaving ───────────────────────────────────

  // Not awaited: the app shouldn't wait on LiveKit before it's usable. The server checks the user
  // may still use the channel; if not, the saved session is dropped.
  restore() {
    const saved = this.#loadSession();
    if (saved) void this.join(saved.channel, saved);
    else localStorage.removeItem(VOICE_KEY);
  }

  #loadSession(): VoiceSession | null {
    try {
      const s = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null");
      return s && typeof s.channel?.id === "number" && s.channel.kind === "voice" ? s : null;
    } catch {
      return null;
    }
  }

  #callPrefs(): VoicePrefs {
    return { muted: this.#wantMuted, deafened: this.deafened };
  }

  #saveSession() {
    if (!this.channel) return;
    const saved: VoiceSession = { channel: this.channel, ...this.#callPrefs() };
    localStorage.setItem(VOICE_KEY, JSON.stringify(saved));
  }

  // Clicking a voice channel: join it, open its call view if already in it, or switch to it.
  // Joins a voice channel, or opens the call view when you're already in it. showCall opens the call
  // view straight away (on a phone the sidebar, and the call's panel in it, are out of sight).
  async open(ch: Channel, showCall = false) {
    if (this.#joining) await this.#joining;
    if (this.channel?.id === ch.id) {
      ui.mainView = "call";
      return;
    }
    if (!this.room) {
      await this.join(ch);
      if (showCall && this.channel?.id === ch.id) ui.mainView = "call";
      return;
    }
    // Switching keeps mute/deafen and stays in the call view if that's where the user was.
    const keep = this.#callPrefs();
    const inCallView = ui.mainView === "call";
    await this.leave();
    await this.join(ch, keep);
    if ((inCallView || showCall) && this.room) ui.mainView = "call";
  }

  async join(ch: Channel, joinPrefs: Partial<VoicePrefs> = {}) {
    if (this.#joining) return this.#joining;
    if (this.room) return;
    this.#joining = (async () => {
      try {
        await this.#connect(ch, joinPrefs);
      } catch (err) {
        console.warn("Couldn't join voice:", err);
      } finally {
        this.#joining = null;
      }
    })();
    return this.#joining;
  }

  async #connect(ch: Channel, joinPrefs: Partial<VoicePrefs>) {
    const res = await session.api("/voice/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: ch.id }),
    });
    if (!res.ok) {
      // Gone, or no longer yours to use: don't keep trying it on every reload.
      if (res.status === 404) localStorage.removeItem(VOICE_KEY);
      return;
    }
    const { token: lkToken } = await res.json();
    await userAudio.loaded;

    const r = new Room({
      // Only pull the video resolution each tile actually displays, and stop sending unwatched layers.
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { deviceId: prefs.devices.audioinput, ...this.#browserSuppression() },
      // Plays everyone through gain nodes on the shared context: per-person volume can go past 100%.
      webAudioMix: { audioContext: audioContext() },
    });
    audioContext().addEventListener("statechange", this.#onAudioState);

    // Discord has separate join/leave sounds for other people; connect/disconnect stand in for them.
    r.on(RoomEvent.ParticipantConnected, (participant) => {
      playSound("connect");
      this.#applyUserAudio(participant);
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
        const sid = track.sid ?? track.source;
        this.#audioEls.set(sid, el);
        document.body.appendChild(el);
        this.#applyUserAudio(participant);
        // LiveKit fades a new track's gain in from 100% and skips it entirely for a volume of 0, so a
        // muted or deafened voice would be audible for a moment. Start it at the right level instead.
        const gain = (track as unknown as { gainNode?: GainNode }).gainNode?.gain;
        if (gain) {
          gain.cancelScheduledValues(0);
          gain.value = userAudio.volumeFor(participant.identity, pub.source, this.deafened);
        }
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

    r.on(RoomEvent.LocalTrackPublished, (pub) => {
      if (pub.source === Track.Source.Microphone) {
        this.#micReplaced();
        void this.#syncNoiseFilter();
      }
      this.#updateParticipants(r);
    });

    // Also fires when the browser's own "Stop sharing" button ends a screen share.
    r.on(RoomEvent.LocalTrackUnpublished, (pub, participant) => {
      if (pub.source === Track.Source.Microphone) this.#speakingDetector.unwatch(participant.identity);
      this.#updateParticipants(r);
    });

    // Keep everyone's names, pictures and mute/deafen indicators current.
    for (const ev of [
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackUnpublished,
      RoomEvent.ParticipantAttributesChanged,
      RoomEvent.ParticipantNameChanged,
    ] as const) {
      r.on(ev, () => this.#updateParticipants(r));
    }

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this.#serverSpeaking = new Set(speakers.map((p) => p.identity));
      this.#refreshSpeaking();
    });

    r.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) this.quality = quality;
    });

    r.on(RoomEvent.AudioPlaybackStatusChanged, () => this.#syncAudioPlayback(r));

    r.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic && participant) this.#dataHandlers.get(topic)?.(participant.identity, payload);
    });

    // Disconnects we didn't ask for (page unload, network drop) keep the saved session so a refresh rejoins.
    r.on(RoomEvent.Disconnected, (reason) => {
      // Our own leave plays its sound in leave(); page unloads are client-initiated too and stay silent.
      // A join that never connected (this.room isn't set yet) isn't a disconnect either.
      if (this.room === r && reason !== DisconnectReason.CLIENT_INITIATED) playSound("disconnect");
      this.#reset();
    });

    // Set before connecting so tracks subscribed during connect start silent.
    this.deafened = joinPrefs.deafened ?? false;
    // Disconnecting while connecting cancels the attempt and rejects connect().
    const giveUp = setTimeout(() => void r.disconnect(), JOIN_TIMEOUT_MS);
    try {
      // Manual subscriptions: voice is always received, screen shares only once someone chooses to watch.
      // LiveKit signalling is routed under /rtc on this same origin.
      await r.connect(wsUrl(), lkToken, { autoSubscribe: false });
    } catch (err) {
      this.deafened = false;
      throw err;
    } finally {
      clearTimeout(giveUp);
    }
    this.room    = r;
    this.channel = ch;
    this.#joinedHooks.forEach((fn) => fn());
    for (const p of r.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) this.#autoSubscribe(pub);
    }
    playSound("connect");
    this.#syncAudioPlayback(r);

    this.#wantMuted = joinPrefs.muted ?? false;
    if (this.#wantMuted || this.deafened) this.muted = true;
    else await this.#setMic(true);
    if (this.deafened) this.#publishDeafened();
    this.#updateParticipants(r);
    this.#saveSession();
  }

  async leave() {
    localStorage.removeItem(VOICE_KEY);
    if (!this.room) return;
    playSound("disconnect");
    await this.room.disconnect();
    this.#reset();
  }

  // Signing out: leaves, but keeps the saved session so signing back in rejoins.
  async disconnect() {
    await this.room?.disconnect();
    this.rooms = new Map();
    this.#justLeft = null;
  }

  // The page is going away.
  destroy() {
    this.room?.disconnect();
  }

  // Idempotent: runs from leave() and again from the Disconnected event.
  #reset() {
    if (this.channel) {
      this.#justLeft = { channelId: this.channel.id, until: Date.now() + JUST_LEFT_MS };
      this.rooms     = this.#hideSelf(this.rooms, false);
    }
    this.#audioEls.forEach((el) => el.remove());
    this.#audioEls.clear();
    this.#speakingDetector.clear();
    this.#serverSpeaking = new Set();
    this.#wantMuted      = false;
    userAudio.closeMenu();
    ui.mainView          = "chat";
    ui.callExpanded      = false;
    this.room            = null;
    this.channel         = null;
    this.muted           = false;
    this.micBlocked      = false;
    this.deafened        = false;
    this.audioBlocked    = false;
    this.quality         = ConnectionQuality.Unknown;
    this.participants    = [];
    this.streams         = [];
    this.speaking        = new Set();
    this.#leftHooks.forEach((fn) => fn());
  }

  // ── Muting and deafening ──────────────────────────────────

  // The server marks you deafened in the call: participants can't set their own attributes (or
  // they could also rename themselves to pose as someone else).
  #publishDeafened() {
    if (!this.room) return;
    void session.submit("/voice/deafened", "PUT", { deafened: this.deafened }).then((err) => {
      if (err) console.warn("Couldn't publish deafen state:", err);
    });
  }

  async toggleDeafen() {
    if (!this.room) return;
    if (!this.deafened) {
      playSound("deafen");
      this.#setIncomingAudio(false);
      if (!this.muted) await this.#setMic(false);
    } else {
      playSound("undeafen");
      this.#setIncomingAudio(true);
      if (!this.#wantMuted) await this.#setMic(true);
    }
    this.#saveSession();
  }

  #setIncomingAudio(on: boolean) {
    this.deafened = !on;
    this.room?.remoteParticipants.forEach((p) => this.#applyUserAudio(p));
    this.#publishDeafened();
    this.#updateParticipants(this.room);
  }

  async #setMic(on: boolean) {
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(on);
      this.muted = !on;
      if (on) this.micBlocked = false;
      this.#applyPushToTalk(); // unmuting re-enables the track
    } catch {
      this.micBlocked = true;
      this.muted = true;
    }
    this.#updateParticipants(this.room);
  }

  async toggleMute() {
    if (!this.room) return;
    const unmute = this.muted;
    // Unmuting while deafened undeafens too, like Discord.
    const undeafen = unmute && this.deafened;
    this.#wantMuted = !unmute;
    if (undeafen) this.#setIncomingAudio(true);
    // Retrying on unmute lets it recover if the user grants permission later.
    await this.#setMic(unmute);
    if (undeafen) playSound("undeafen");
    else if (!unmute) playSound("mute");
    else if (!this.muted) playSound("unmute"); // silent if the mic still couldn't be opened
    this.#saveSession();
  }

  // ── Audio playback ────────────────────────────────────────

  #syncAudioPlayback(r: Room) {
    // Voices play through the shared context, so this is also what sounds and speaking detection need.
    this.audioBlocked = !r.canPlaybackAudio;
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

  // LiveKit remembers these per source and applies them to tracks that arrive later.
  #applyUserAudio(p: RemoteParticipant) {
    for (const source of [Track.Source.Microphone, Track.Source.ScreenShareAudio] as const) {
      p.setVolume(userAudio.volumeFor(p.identity, source, this.deafened), source);
    }
  }

  // ── Devices, noise suppression and push-to-talk ───────────

  // Takes effect at once, in a call too; new joins and mic re-enables use it as well.
  async setDevice(kind: AudioDeviceKind, deviceId: string) {
    prefs.saveDevice(kind, deviceId);
    if (kind === "audiooutput") await setOutputDevice(deviceId);
    else await this.room?.switchActiveDevice(kind, deviceId).catch((err) => console.warn("Couldn't switch microphone:", err));
    this.#micReplaced();
  }

  // Takes effect at once, in a call too.
  async setNoiseSuppression(level: NoiseSuppression) {
    const browserChanged = (level === "off") !== (prefs.noiseSuppression === "off");
    prefs.saveNoiseSuppression(level);
    const track = this.#micTrack();
    if (browserChanged && track && this.room) {
      // The browser's own suppression is set when the microphone opens, so reopen it.
      const capture = Object.assign(this.room.options.audioCaptureDefaults!, this.#browserSuppression());
      await track.restartTrack({ ...capture }).catch((err) => console.warn("Couldn't reopen microphone:", err));
      this.#micReplaced();
    }
    await this.#syncNoiseFilter();
  }

  // Sliders fire continuously: applied as it moves, in a call too.
  setNoiseStrength(strength: number) {
    prefs.saveNoiseStrength(strength);
    const filter = this.#micTrack()?.getProcessor();
    if (filter instanceof NoiseFilter) filter.setStrength(strength);
  }

  #browserSuppression() {
    const on = prefs.noiseSuppression !== "off";
    return { noiseSuppression: on, voiceIsolation: on };
  }

  // Strong suppression filters the microphone once audio may play: before the first click or key
  // press (an automatic rejoin after a refresh) the filter's audio couldn't start, and would send
  // silence. #onAudioState runs this again once it can.
  #syncNoiseFilter() {
    this.#noiseFilterSync = this.#noiseFilterSync
      .then(() => this.#updateNoiseFilter())
      // The call keeps the unfiltered microphone.
      .catch((err) => console.warn("Couldn't change the noise filter:", err));
    return this.#noiseFilterSync;
  }

  async #updateNoiseFilter() {
    const track = this.#micTrack();
    if (!track) return;
    const want = prefs.noiseSuppression === "strong" && canSuppressNoise && audioRunning();
    if (want === (track.getProcessor() instanceof NoiseFilter)) return;
    try {
      if (want) await track.setProcessor(new NoiseFilter(prefs.noiseStrength));
      else await track.stopProcessor();
    } finally {
      this.#micReplaced();
    }
  }

  #micTrack() {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
  }

  // The microphone itself: under the noise filter, LiveKit's mediaStreamTrack is the filtered copy.
  #micInput() {
    const track = this.#micTrack();
    const filter = track?.getProcessor();
    return filter instanceof NoiseFilter ? filter.input : track?.mediaStreamTrack;
  }

  // The microphone's track changed (another device, the noise filter going on or off): push-to-talk
  // and your speaking ring follow the track the call is sent.
  #micReplaced() {
    this.#applyPushToTalk(); // a new mic track starts enabled
    const track = this.#micTrack();
    if (track && this.room) this.#speakingDetector.watch(this.room.localParticipant.identity, track.mediaStreamTrack);
  }

  setKeybinds(keybinds: KeybindPrefs) {
    prefs.saveKeybinds(keybinds);
    this.#applyPushToTalk();
  }

  // Push-to-talk: the mic stays published and unmuted (so nobody sees a mute icon flicker); what
  // it sends is silenced until the key is held. Muting yourself or deafening still wins.
  pushToTalk(held: boolean) {
    clearTimeout(this.#pttRelease);
    if (held) {
      this.#pttHeld = true;
      this.#applyPushToTalk();
    } else {
      this.#pttRelease = setTimeout(() => {
        this.#pttHeld = false;
        this.#applyPushToTalk();
      }, PTT_RELEASE_MS);
    }
  }

  // Silencing the microphone itself also silences the noise filter's output.
  #applyPushToTalk() {
    const input = this.#micInput();
    if (input) input.enabled = !prefs.keybinds.pushToTalk || this.#pttHeld;
  }

  // ── Screen shares ─────────────────────────────────────────

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
    if (on) ui.mainView = "call";
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

  // ── Who's in the call ─────────────────────────────────────

  #refreshSpeaking() {
    this.speaking = audioRunning() ? this.#speakingDetector.speaking : this.#serverSpeaking;
  }

  #updateParticipants(r: Room | null) {
    if (!r) return;
    const local = r.localParticipant;
    const next: VoiceParticipant[] = [
      // Local state comes from this store so it updates before LiveKit round-trips.
      {
        identity: local.identity, name: local.name || local.identity, avatar: session.me?.avatar ?? "",
        muted: this.muted, deafened: this.deafened,
      },
      ...Array.from(r.remoteParticipants.values(), (p) => ({
        identity: p.identity,
        name:     p.name || p.identity,
        avatar:   avatarOf(p),
        // No published mic (never enabled, or permission denied) also counts as muted.
        muted:    !p.isMicrophoneEnabled,
        deafened: p.attributes[DEAFENED_ATTR] === "1",
      })),
    ];
    if (!sameParticipants(next, this.participants)) this.participants = next;
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

export const voice = new Voice();
