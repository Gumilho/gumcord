import {
  ConnectionQuality, DisconnectReason, Room, RoomEvent, Track,
  type Participant, type RemoteParticipant, type RemoteTrackPublication,
} from "livekit-client";
import { audioContext, audioRunning, resumeAudio, setOutputDevice } from "./audio.ts";
import { SpeakingDetector } from "./speaking.ts";
import { playClip, playSound, preloadSounds } from "./sounds.ts";
import { serverMessage, t } from "./i18n.svelte.ts";

export type ChannelKind = "text" | "voice";
// Servers group channels. Admins see every server; everyone else, the ones they've been added to.
export interface Server { id: number; name: string; icon: string; }
export interface Channel { id: number; server_id: number; name: string; kind: ChannelKind; }
type AttachmentType = "image" | "video" | "sticker" | "file";
export interface Message {
  id: number; channel_id: number; author_id: number; author: string; content: string; created_at: string;
  edited_at?: string; attachment_url?: string; attachment_type?: AttachmentType;
}
interface Attachment { url: string; type: AttachmentType; name: string; }
export interface User { id: number; name: string; avatar: string; admin: boolean; }
// Something a server's members uploaded: an emote (a picture written :name: in messages), a sticker
// (a bigger picture sent on its own) or a soundboard sound. Whoever added it, or an admin, can remove it.
export interface ServerItem { id: number; name: string; url: string; created_by: number; }
export type Emote = ServerItem;
export type Sticker = ServerItem;
export type Sound = ServerItem;
export type Library = "emotes" | "stickers" | "sounds";
// identity is the stable user ID; name is the display name to show.
export interface VoiceParticipant { identity: string; name: string; avatar: string; muted: boolean; deafened: boolean; }
// Someone in a voice channel as the server reports it, for channels you aren't in yourself.
export interface VoiceMember extends VoiceParticipant { streaming: boolean; }
// The server polls LiveKit every 2 s, so its list still has you briefly after you leave.
const JUST_LEFT_MS = 5_000;
// How loud this user hears another in voice (1 = 100%, up to 2), or whether they've muted them.
// Local to the listener: the other person isn't affected or told.
// Their screen-share audio has its own volume and mute.
export interface UserAudio { volume: number; muted: boolean; streamVolume: number; streamMuted: boolean; }
const DEFAULT_USER_AUDIO: UserAudio = { volume: 1, muted: false, streamVolume: 1, streamMuted: false };
// Which of someone's audio a setting or the menu is about.
export type AudioKind = "voice" | "stream";
// Sliders fire continuously; save once the value settles.
const USER_AUDIO_SAVE_MS = 400;
// track is null until the viewer opts in to watching; loading covers the gap after they do.
export interface ScreenStream { identity: string; name: string; local: boolean; track: Track | null; loading: boolean; }

// LiveKit has no deafen concept, so each client publishes it as a participant attribute.
const DEAFENED_ATTR = "deafened";
// Set from the voice token. Attributes are client-writable, so only pictures from our own store are used.
const avatarOf = (p: Participant) => (p.attributes.avatar?.startsWith("/files/") ? p.attributes.avatar : "");

// Set by the desktop app. Its webview can't use passkeys, so it signs in through the system browser.
export const isDesktop = "gumcordDesktop" in window;
// After signing out, show the sign-in screen instead of going straight back to PocketID.
const SIGNED_OUT_KEY = "gc_signed_out";
// Whether the member list is shown, remembered per device.
const MEMBERS_KEY = "gc_members";
// Keyboard shortcuts and push-to-talk, remembered per device.
const KEYBINDS_KEY = "gc_keybinds";
// A key plus the modifiers held with it. code is KeyboardEvent.code, e.g. "KeyM" or "F13".
export interface Keybind { code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; }
export type KeybindAction = "toggleMute" | "toggleDeafen" | "pushToTalk";
export interface KeybindPrefs { pushToTalk: boolean; binds: Record<KeybindAction, Keybind | null>; }
const DEFAULT_KEYBINDS: KeybindPrefs = {
  pushToTalk: false,
  binds: {
    toggleMute:   { code: "KeyM", ctrl: true, shift: true, alt: false, meta: false },
    toggleDeafen: { code: "KeyD", ctrl: true, shift: true, alt: false, meta: false },
    pushToTalk:   null,
  },
};
// Holding push-to-talk a moment after release keeps the ends of words.
const PTT_RELEASE_MS = 150;

// Soundboard: sounds travel through the call as data messages naming one of the server's uploads.
const SOUNDBOARD_TOPIC   = "soundboard";
const SOUND_URL          = /^\/files\/sound-[0-9a-f]{24}\.(?:mp3|wav|ogg)$/;
const SOUND_COOLDOWN_MS  = 1_000;
const SOUND_VOLUME_KEY   = "gc_soundboard_volume";

function loadSoundboardVolume() {
  const v = Number(localStorage.getItem(SOUND_VOLUME_KEY) ?? "0.5");
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5;
}

// Chosen microphone and speakers, remembered per device. Missing means the system default.
const DEVICES_KEY = "gc_devices";
export type AudioDeviceKind = "audioinput" | "audiooutput";
type DevicePrefs = Partial<Record<AudioDeviceKind, string>>;

const WS_RECONNECT_BASE = 1_000;  // ms
const WS_RECONNECT_MAX  = 30_000; // ms

// Per-device session state, so a page refresh lands back where the user was.
const SERVER_KEY  = "gc_server";
const CHANNEL_KEY = "gc_channels"; // { [serverId]: channelId }, the last text channel read in each server
const VOICE_KEY   = "gc_voice";
interface VoicePrefs   { muted: boolean; deafened: boolean; }
// The whole channel, not just its ID: the call may be in a server other than the one on screen.
interface VoiceSession extends VoicePrefs { channel: Channel; }

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

// What went wrong, from a failed response: the server's reason in the app's language.
async function errorText(res: Response) {
  const text = (await res.text()).trim();
  return text ? serverMessage(text) : t("Failed ({status}).", { status: res.status });
}

const sameParticipants = (a: VoiceParticipant[], b: VoiceParticipant[]) =>
  a.length === b.length
  && a.every((p, i) => p.identity === b[i].identity && p.name === b[i].name && p.avatar === b[i].avatar
    && p.muted === b[i].muted && p.deafened === b[i].deafened);

const sameStreams = (a: ScreenStream[], b: ScreenStream[]) =>
  a.length === b.length
  && a.every((s, i) => s.identity === b[i].identity && s.name === b[i].name && s.track === b[i].track && s.loading === b[i].loading);

function loadKeybinds(): KeybindPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEYBINDS_KEY) ?? "null");
    return saved ? { ...DEFAULT_KEYBINDS, ...saved, binds: { ...DEFAULT_KEYBINDS.binds, ...saved.binds } } : DEFAULT_KEYBINDS;
  } catch {
    return DEFAULT_KEYBINDS;
  }
}

function loadDevicePrefs(): DevicePrefs {
  try {
    const prefs: DevicePrefs = JSON.parse(localStorage.getItem(DEVICES_KEY) ?? "{}") ?? {};
    // Applied to the shared audio context once it exists.
    if (prefs.audiooutput) void setOutputDevice(prefs.audiooutput);
    return prefs;
  } catch {
    return {};
  }
}

class GumcordStore {
  // auth: the session is an HttpOnly cookie, so the server's answer to /me is the only source of truth
  me:        User | null = $state(null);
  signedOut  = $state(false);

  // boot
  bootError = $state("");
  booted    = $state(false);

  // servers, and the open server's channels and members
  servers:       Server[]       = $state([]);
  activeServer:  Server | null  = $state(null);
  members:       User[]         = $state.raw([]);
  emotes:        Emote[]        = $state.raw([]);
  stickers:      Sticker[]      = $state.raw([]);
  // By lowercase name: :Kappa: and :kappa: are one emote.
  emoteMap = $derived(new Map(this.emotes.map((e) => [e.name.toLowerCase(), e])));
  // The soundboard of the server your call is in (which may not be the one on screen).
  sounds:        Sound[]        = $state.raw([]);
  soundboardVolume              = $state(loadSoundboardVolume());

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
  // Everyone with the app open, sorted by name; pushed by the server.
  online:            User[]               = $state.raw([]);
  showMembers                             = $state(localStorage.getItem(MEMBERS_KEY) !== "0");
  devices:           DevicePrefs          = $state(loadDevicePrefs());
  keybinds:          KeybindPrefs         = $state(loadKeybinds());
  // While the settings dialog records a new key, shortcuts are off.
  recordingKeybind                        = $state(false);
  // Who is in each voice channel (by channel ID), pushed by the server. Replaced wholesale on change.
  voiceRooms:        ReadonlyMap<number, VoiceMember[]> = $state.raw(new Map());
  // Per-person volume and mute, by identity (user ID). Replaced wholesale on change.
  userAudio:         ReadonlyMap<string, UserAudio> = $state.raw(new Map());
  // The per-person audio menu, opened by right-clicking someone in the call.
  userMenu: { identity: string; name: string; kind: AudioKind; x: number; y: number } | null = $state(null);
  screenSharing                           = $derived(this.streams.some((s) => s.local));
  readonly canScreenShare                 = typeof navigator.mediaDevices?.getDisplayMedia === "function";

  // The user's own mute choice, independent of deafen and mic-permission failures.
  #wantMuted        = false;
  // The join under way, if any: a click during the auto-rejoin waits for it instead of opening a second room.
  #joining: Promise<void> | null = null;
  #audioResumeArmed = false;
  // Local level detection drives the speaking ring; the server's slower updates are the fallback.
  #speakingDetector = new SpeakingDetector(() => this.#refreshSpeaking());
  #serverSpeaking   = new Set<string>();

  // private
  #ws:           WebSocket | null              = null;
  #wsRetries     = 0;
  #wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #audioEls:     Map<string, HTMLAudioElement> = new Map();
  #userAudioSaves = new Map<string, ReturnType<typeof setTimeout>>();
  // When you, and each person in the call, last played a sound.
  #soundPlayed = new Map<string, number>();
  // Push-to-talk key held (or within the release delay).
  #pttHeld = false;
  #pttRelease: ReturnType<typeof setTimeout> | undefined;
  // The channel you just left, where you're hidden until the server's list catches up.
  #justLeft: { channelId: number; until: number } | null = null;
  // Joining voice waits for this, so nobody is heard at the default volume before their setting loads.
  #userAudioLoaded: Promise<void> = Promise.resolve();
  #fetchAbort:   AbortController | null        = null;

  // Labels shared by the sidebar and call-view controls.
  get muteLabel() {
    return t(this.micBlocked ? "Microphone unavailable. Check permissions" : this.voiceMuted ? "Unmute" : "Mute");
  }

  get deafenLabel() {
    return t(this.voiceDeafened ? "Undeafen" : "Deafen");
  }

  get shareLabel() {
    if (!this.canScreenShare) return t("Screen sharing isn't supported in this window");
    return t(this.screenSharing ? "Stop sharing" : "Share your screen");
  }

  // API request with a timeout. A 401 means the session ended, which drops back to the login screen.
  async #api(path: string, init: RequestInit = {}, ms?: number) {
    const res = await fetchWithTimeout(`/api${path}`, init, ms);
    if (res.status === 401 && this.me) void this.#endSession().then(() => this.#needSignIn());
    return res;
  }

  // ── Auth ──────────────────────────────────────────────────

  // No valid session. The web app goes straight to PocketID; the desktop app, and anyone who just
  // signed out, gets the sign-in screen (which the desktop app needs a click on to open the browser).
  #needSignIn() {
    if (!isDesktop && !localStorage.getItem(SIGNED_OUT_KEY)) {
      location.replace("/api/auth/login");
      return;
    }
    this.signedOut = true;
  }

  // Web sign-in from the sign-in screen; the desktop flow lives in Login.svelte.
  signIn() {
    localStorage.removeItem(SIGNED_OUT_KEY);
    location.href = "/api/auth/login";
  }

  async logout() {
    await fetchWithTimeout("/api/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem(SERVER_KEY);
    localStorage.removeItem(CHANNEL_KEY);
    localStorage.removeItem(VOICE_KEY);
    localStorage.setItem(SIGNED_OUT_KEY, "1");
    await this.#endSession();
    this.signedOut = true;
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
    this.servers       = [];
    this.activeServer  = null;
    this.members       = [];
    this.channels      = [];
    this.messages      = [];
    this.userAudio     = new Map();
    this.voiceRooms    = new Map();
    this.online        = [];
    this.#justLeft     = null;
    this.activeChannel = null;
    this.bootError     = "";
    this.booted        = false;
  }

  // ── Boot ──────────────────────────────────────────────────

  async boot() {
    this.bootError = "";
    try {
      await this.#boot();
    } catch (err) {
      // Anything unexpected must land on the error screen, never leave the splash up forever.
      console.error("Boot failed:", err);
      this.bootError = t("Couldn't load Gumcord: {error}", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async #boot() {
    let me: Response, servers: Response;
    try {
      [me, servers] = await Promise.all([this.#api("/me"), this.#api("/servers")]);
    } catch {
      this.bootError = t("Cannot reach server. Is the backend running?");
      return;
    }
    if (me.status === 401) { this.#needSignIn(); return; }
    if (!me.ok || !servers.ok) { this.bootError = t("Server error ({status}).", { status: me.ok ? servers.status : me.status }); return; }

    this.me        = await me.json();
    this.signedOut = false;
    localStorage.removeItem(SIGNED_OUT_KEY);
    this.servers   = await servers.json();
    const savedId  = Number(localStorage.getItem(SERVER_KEY));
    const server   = this.servers.find((s) => s.id === savedId) ?? this.servers[0];
    // Everything below only needs to know who you are, so it runs while the server loads.
    const loading = server ? this.selectServer(server) : undefined;
    void preloadSounds();
    this.#userAudioLoaded = this.#loadUserAudio();
    this.#openWS();
    this.#restoreVoice();
    await loading;
    this.booted = true;
  }

  // Not awaited: the app shouldn't wait on LiveKit before it's usable. The server checks the user
  // may still use the channel; if not, the saved session is dropped.
  #restoreVoice() {
    const saved = this.#loadVoiceSession();
    if (saved) void this.joinVoice(saved.channel, saved);
    else localStorage.removeItem(VOICE_KEY);
  }

  #loadVoiceSession(): VoiceSession | null {
    try {
      const s = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null");
      return s && typeof s.channel?.id === "number" && s.channel.kind === "voice" ? s : null;
    } catch {
      return null;
    }
  }

  #voicePrefs(): VoicePrefs {
    return { muted: this.#wantMuted, deafened: this.voiceDeafened };
  }

  #saveVoiceSession() {
    if (!this.voiceChannel) return;
    const session: VoiceSession = { channel: this.voiceChannel, ...this.#voicePrefs() };
    localStorage.setItem(VOICE_KEY, JSON.stringify(session));
  }

  destroy() {
    clearTimeout(this.#wsRetryTimer ?? undefined);
    this.#ws?.close();
    this.room?.disconnect();
  }

  // ── Servers ───────────────────────────────────────────────

  // The server the current call is in, which may not be the one on screen.
  get voiceServer() {
    return this.servers.find((s) => s.id === this.voiceChannel?.server_id) ?? null;
  }

  async selectServer(server: Server) {
    this.activeServer = server;
    this.mainView     = "chat";
    localStorage.setItem(SERVER_KEY, String(server.id));
    await this.#loadServer(server);
  }

  // Loads a server's channels and members, staying on the open text channel if it's still there.
  async #loadServer(server: Server) {
    const [channels, members, emotes, stickers] = await Promise.all([
      this.#api(`/servers/${server.id}/channels`),
      this.#api(`/servers/${server.id}/members`),
      this.#api(`/servers/${server.id}/emotes`),
      this.#api(`/servers/${server.id}/stickers`),
    ]);
    if (this.activeServer?.id !== server.id) return; // switched to another server meanwhile
    this.channels = channels.ok ? await channels.json() : [];
    this.members  = members.ok ? await members.json() : [];
    this.emotes   = emotes.ok ? await emotes.json() : [];
    this.stickers = stickers.ok ? await stickers.json() : [];

    const current = this.channels.find((c) => c.id === this.activeChannel?.id);
    if (current) {
      this.activeChannel = current; // picks up a rename
      return;
    }
    const savedId = this.#savedChannels()[server.id];
    const text = this.channels.find((c) => c.kind === "text" && c.id === savedId)
              ?? this.channels.find((c) => c.kind === "text");
    if (text) {
      await this.selectChannel(text);
    } else {
      this.activeChannel = null;
      this.messages      = [];
    }
  }

  // The open server's emotes or stickers, after someone changed them.
  async #loadServerItems(library: "emotes" | "stickers") {
    const server = this.activeServer;
    if (!server) return;
    const res = await this.#api(`/servers/${server.id}/${library}`);
    if (res.ok && this.activeServer?.id === server.id) this[library] = await res.json();
  }

  async #loadSounds() {
    const serverId = this.voiceChannel?.server_id;
    if (serverId === undefined) return;
    const res = await this.#api(`/servers/${serverId}/sounds`);
    if (res.ok && this.voiceChannel?.server_id === serverId) this.sounds = await res.json();
  }

  // Emotes go to the server on screen, sounds to the server of your call. Answers with an error to
  // show, or "". The lists themselves update from the server's broadcast, which reaches this client too.
  async addItem(library: Library, name: string, file: File): Promise<string> {
    const serverId = this.#libraryServer(library);
    if (serverId === undefined) return t("No server open.");
    const form = new FormData();
    form.append("name", name);
    form.append("file", file);
    return this.#submit(`/servers/${serverId}/${library}`, "POST", form);
  }

  async removeItem(library: Library, item: ServerItem): Promise<string> {
    const serverId = this.#libraryServer(library);
    if (serverId === undefined) return t("No server open.");
    return this.#submit(`/servers/${serverId}/${library}/${item.id}`, "DELETE");
  }

  canRemove(item: ServerItem) {
    return !!this.me && (this.me.admin || this.me.id === item.created_by);
  }

  #libraryServer(library: Library) {
    return library === "sounds" ? this.voiceChannel?.server_id : this.activeServer?.id;
  }


  // ── Soundboard ────────────────────────────────────────────

  // Plays for everyone in the call, you included. One sound a second.
  playSoundboard(sound: Sound) {
    const r = this.room;
    const me = String(this.me?.id);
    if (!r || Date.now() - (this.#soundPlayed.get(me) ?? 0) < SOUND_COOLDOWN_MS) return;
    this.#soundPlayed.set(me, Date.now());
    const data = new TextEncoder().encode(JSON.stringify({ url: sound.url }));
    r.localParticipant.publishData(data, { reliable: true, topic: SOUNDBOARD_TOPIC })
      .catch((err) => console.warn("Couldn't play sound for the call:", err));
    this.#hearSound(me, sound.url);
  }

  // Only your ears: to try a sound before playing it to everyone.
  previewSound(sound: Sound) {
    void playClip(sound.url, this.soundboardVolume);
  }

  setSoundboardVolume(volume: number) {
    this.soundboardVolume = volume;
    localStorage.setItem(SOUND_VOLUME_KEY, String(volume));
  }

  #hearSound(identity: string, url: string) {
    if (this.voiceDeafened || this.userAudioFor(identity).muted) return;
    void playClip(url, this.soundboardVolume);
  }

  // Someone in the call played a sound. Only the server's own uploads, and no faster than the button allows.
  #onSoundboard(identity: string, payload: Uint8Array) {
    let url: unknown;
    try {
      url = JSON.parse(new TextDecoder().decode(payload)).url;
    } catch {
      return;
    }
    if (typeof url !== "string" || !SOUND_URL.test(url)) return;
    if (Date.now() - (this.#soundPlayed.get(identity) ?? 0) < SOUND_COOLDOWN_MS / 2) return;
    this.#soundPlayed.set(identity, Date.now());
    this.#hearSound(identity, url);
  }

  // An admin changed servers, channels or members: refetch what this user can see now.
  async #refreshServers() {
    const res = await this.#api("/servers");
    if (!res.ok) return;
    this.servers = await res.json();
    const open = this.servers.find((s) => s.id === this.activeServer?.id);
    if (open) {
      this.activeServer = open;
      await this.#loadServer(open);
    } else if (this.servers.length > 0) {
      await this.selectServer(this.servers[0]);
    } else {
      this.activeServer  = null;
      this.channels      = [];
      this.members       = [];
      this.emotes        = [];
      this.stickers      = [];
      this.activeChannel = null;
      this.messages      = [];
    }
    // Removed from the server of your call: the server also ends it on LiveKit's side.
    if (this.voiceChannel && !this.voiceServer) await this.leaveVoice();
  }

  #savedChannels(): Record<number, number> {
    try {
      return JSON.parse(localStorage.getItem(CHANNEL_KEY) ?? "{}") ?? {};
    } catch {
      return {};
    }
  }

  // ── Your profile ──────────────────────────────────────────

  // Each returns an error message, or "" on success. An empty name goes back to your PocketID name.
  updateName(name: string) {
    return this.#profileRequest("/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  }

  setAvatar(file: File) {
    const form = new FormData();
    form.append("file", file);
    return this.#profileRequest("/me/avatar", { method: "PUT", body: form }, UPLOAD_TIMEOUT_MS);
  }

  resetAvatar() {
    return this.#profileRequest("/me/avatar", { method: "DELETE" });
  }

  async #profileRequest(path: string, init: RequestInit, ms?: number): Promise<string> {
    try {
      const res = await this.#api(path, init, ms);
      if (!res.ok) return await errorText(res);
      // The server also updates any call you're in, name and picture in one request. (Doing it from
      // here would race: each LiveKit update carries the others' current values.)
      this.me = await res.json();
      return "";
    } catch {
      return t("Can't reach the server.");
    }
  }

  // ── Admin: servers and members ────────────────────────────

  // A change the server answers with nothing but success or a reason: returns the error to show, or
  // "". The server's live update refreshes everyone, this client included. Forms are uploads.
  async #submit(path: string, method: string, body?: unknown): Promise<string> {
    const form = body instanceof FormData;
    try {
      const res = await this.#api(path, {
        method,
        headers: body && !form ? { "Content-Type": "application/json" } : undefined,
        body: form ? body : body ? JSON.stringify(body) : undefined,
      }, form ? UPLOAD_TIMEOUT_MS : undefined);
      return res.ok ? "" : await errorText(res);
    } catch {
      return t("Can't reach the server.");
    }
  }

  async createServer(name: string): Promise<string> {
    const res = await this.#api("/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    if (!res?.ok) return res ? await errorText(res) : t("Can't reach the server.");
    const created: Server = await res.json();
    this.servers = [...this.servers.filter((s) => s.id !== created.id), created];
    await this.selectServer(created);
    return "";
  }

  renameServer(id: number, name: string) {
    return this.#submit(`/servers/${id}`, "PATCH", { name });
  }

  deleteServer(id: number) {
    return this.#submit(`/servers/${id}`, "DELETE");
  }

  setServerIcon(id: number, file: File) {
    const form = new FormData();
    form.append("file", file);
    return this.#submit(`/servers/${id}/icon`, "PUT", form);
  }

  removeServerIcon(id: number) {
    return this.#submit(`/servers/${id}/icon`, "DELETE");
  }

  addMember(serverId: number, userId: number) {
    return this.#submit(`/servers/${serverId}/members/${userId}`, "PUT");
  }

  removeMember(serverId: number, userId: number) {
    return this.#submit(`/servers/${serverId}/members/${userId}`, "DELETE");
  }

  // Everyone who has signed in, for adding people to a server.
  async allUsers(): Promise<User[]> {
    const res = await this.#api("/users").catch(() => null);
    return res?.ok ? res.json() : [];
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
    localStorage.setItem(CHANNEL_KEY, JSON.stringify({ ...this.#savedChannels(), [ch.server_id]: ch.id }));

    try {
      const res = await this.#api(`/channels/${ch.id}/messages`, { signal: this.#fetchAbort.signal });
      this.messages = res.ok ? await res.json() : [];
    } catch (err) {
      if ((err as Error).name !== "AbortError") this.messages = [];
    }
  }

  // Admins only. Shows up for everyone through the server's live update.
  async createChannel(name: string, kind: ChannelKind) {
    if (!this.activeServer) return;
    const res = await this.#api(`/servers/${this.activeServer.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, kind }),
    });
    if (!res.ok) return;
    const ch: Channel = await res.json();
    if (!this.channels.some((c) => c.id === ch.id)) this.channels = [...this.channels, ch];
  }

  // Admins only. Everyone's channel list updates from the server's broadcast.
  renameChannel(id: number, name: string) {
    return this.#submit(`/channels/${id}`, "PATCH", { name });
  }

  deleteChannel(id: number) {
    return this.#submit(`/channels/${id}`, "DELETE");
  }

  async uploadFile(file: File) {
    this.uploadError = "";
    this.uploading   = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await this.#api("/upload", { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
      if (!res.ok) {
        this.uploadError = t(res.status === 413 ? "File too large (max 25 MB)."
          : res.status === 429 ? "Too many uploads at once. Try again in a moment." : "Upload failed.");
        return;
      }
      this.pendingAttachment = await res.json();
    } catch {
      this.uploadError = t("Upload failed.");
    } finally {
      this.uploading = false;
    }
  }

  // Your own messages; admins can also delete anyone's. Everyone's view updates from the server's broadcast.
  editMessage(id: number, content: string) {
    return this.#submit(`/messages/${id}`, "PATCH", { content });
  }

  deleteMessage(id: number) {
    return this.#submit(`/messages/${id}`, "DELETE");
  }

  canEdit(msg: Message) {
    return msg.author_id === this.me?.id;
  }

  canDelete(msg: Message) {
    return msg.author_id === this.me?.id || !!this.me?.admin;
  }

  sendMessage() {
    const content = this.draft.trim();
    const att     = this.pendingAttachment;
    if (!content && !att) return;
    if (!this.#send(content, att?.url ?? "", att?.type ?? "")) return;
    this.draft             = "";
    this.pendingAttachment = null;
  }

  // A sticker goes out on its own, leaving whatever you were typing.
  sendSticker(sticker: Sticker) {
    this.#send("", sticker.url, "sticker");
  }

  #send(content: string, attachmentUrl: string, attachmentType: string) {
    if (!this.activeChannel || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify({
      channel_id:      this.activeChannel.id,
      content,
      attachment_url:  attachmentUrl,
      attachment_type: attachmentType,
    }));
    return true;
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
      let data: Message
        | { type: "voice"; channels: Record<string, VoiceMember[]> }
        | { type: "online"; users: User[] }
        | { type: "servers" }
        | { type: Library; server_id: number }
        | { type: "message_edited"; id: number; content: string; edited_at: string }
        | { type: "message_deleted"; id: number };
      try { data = JSON.parse(e.data); } catch { return; }
      if ("type" in data) {
        if (data.type === "voice") this.#setVoiceRooms(data.channels);
        else if (data.type === "online") this.online = data.users;
        else if (data.type === "servers") void this.#refreshServers();
        else if (data.type === "message_edited") {
          this.messages = this.messages.map((m) => (m.id === data.id ? { ...m, content: data.content, edited_at: data.edited_at } : m));
        } else if (data.type === "message_deleted") this.messages = this.messages.filter((m) => m.id !== data.id);
        else if ((data.type === "emotes" || data.type === "stickers") && data.server_id === this.activeServer?.id) void this.#loadServerItems(data.type);
        else if (data.type === "sounds" && data.server_id === this.voiceChannel?.server_id) void this.#loadSounds();
        return;
      }
      const msg = data;
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

  // Takes effect at once, in a call too; new joins and mic re-enables use it as well.
  async setDevice(kind: AudioDeviceKind, deviceId: string) {
    this.devices = { ...this.devices, [kind]: deviceId };
    localStorage.setItem(DEVICES_KEY, JSON.stringify(this.devices));
    if (kind === "audiooutput") await setOutputDevice(deviceId);
    else await this.room?.switchActiveDevice(kind, deviceId).catch((err) => console.warn("Couldn't switch microphone:", err));
    this.#applyPushToTalk(); // a new mic track starts enabled
  }

  setKeybinds(prefs: KeybindPrefs) {
    this.keybinds = prefs;
    localStorage.setItem(KEYBINDS_KEY, JSON.stringify(prefs));
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

  #applyPushToTalk() {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (track) track.mediaStreamTrack.enabled = !this.keybinds.pushToTalk || this.#pttHeld;
  }

  toggleMembers() {
    this.showMembers = !this.showMembers;
    localStorage.setItem(MEMBERS_KEY, this.showMembers ? "1" : "0");
  }

  #setVoiceRooms(channels: Record<string, VoiceMember[]>) {
    // Avatars are client-set attributes relayed by the server: only use pictures from our own store.
    this.voiceRooms = this.#withoutSelfIfJustLeft(new Map(Object.entries(channels).map(([id, members]) => [
      Number(id),
      members.map((m) => ({ ...m, avatar: m.avatar?.startsWith("/files/") ? m.avatar : "" })),
    ])), true);
  }

  // Hides you from the channel you just left until a server update no longer lists you there.
  #withoutSelfIfJustLeft(rooms: ReadonlyMap<number, VoiceMember[]>, fromServer: boolean) {
    const left = this.#justLeft;
    if (!left) return rooms;
    const me = String(this.me?.id);
    const members = rooms.get(left.channelId) ?? [];
    const listed = members.some((m) => m.identity === me);
    if ((fromServer && !listed) || Date.now() > left.until) {
      this.#justLeft = null;
      return rooms;
    }
    return listed ? new Map(rooms).set(left.channelId, members.filter((m) => m.identity !== me)) : rooms;
  }

  // ── Voice ─────────────────────────────────────────────────

  // Clicking a voice channel: join it, open its call view if already in it, or switch to it.
  // Joins a voice channel, or opens the call view when you're already in it. showCall opens the call
  // view straight away (on a phone the sidebar, and the call's panel in it, are out of sight).
  async openVoiceChannel(ch: Channel, showCall = false) {
    if (this.#joining) await this.#joining;
    if (this.voiceChannel?.id === ch.id) {
      this.mainView = "call";
      return;
    }
    if (!this.room) {
      await this.joinVoice(ch);
      if (showCall && this.voiceChannel?.id === ch.id) this.mainView = "call";
      return;
    }
    // Switching keeps mute/deafen and stays in the call view if that's where the user was.
    const prefs = this.#voicePrefs();
    const inCallView = this.mainView === "call";
    await this.leaveVoice();
    await this.joinVoice(ch, prefs);
    if ((inCallView || showCall) && this.room) this.mainView = "call";
  }

  async joinVoice(ch: Channel, prefs: Partial<VoicePrefs> = {}) {
    if (this.#joining) return this.#joining;
    if (this.room) return;
    this.#joining = (async () => {
      try {
        await this.#connectVoice(ch, prefs);
      } catch (err) {
        console.warn("Couldn't join voice:", err);
      } finally {
        this.#joining = null;
      }
    })();
    return this.#joining;
  }

  async #connectVoice(ch: Channel, prefs: Partial<VoicePrefs>) {
    const res = await this.#api("/voice/token", {
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
    await this.#userAudioLoaded;

    const r = new Room({
      // Only pull the video resolution each tile actually displays, and stop sending unwatched layers.
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { deviceId: this.devices.audioinput },
      // Plays everyone through gain nodes on the shared context: per-person volume can go past 100%.
      webAudioMix: { audioContext: audioContext() },
    });

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
          gain.value = this.#volumeFor(participant.identity, pub.source);
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

    r.on(RoomEvent.LocalTrackPublished, (pub, participant) => {
      if (pub.source === Track.Source.Microphone) this.#applyPushToTalk();
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
      if (participant.isLocal) this.voiceQuality = quality;
    });

    r.on(RoomEvent.AudioPlaybackStatusChanged, () => this.#syncAudioPlayback(r));

    r.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic === SOUNDBOARD_TOPIC && participant) this.#onSoundboard(participant.identity, payload);
    });

    // Disconnects we didn't ask for (page unload, network drop) keep the saved session so a refresh rejoins.
    r.on(RoomEvent.Disconnected, (reason) => {
      // Our own leave plays its sound in leaveVoice; page unloads are client-initiated too and stay silent.
      // A join that never connected (this.room isn't set yet) isn't a disconnect either.
      if (this.room === r && reason !== DisconnectReason.CLIENT_INITIATED) playSound("disconnect");
      this.#resetVoice();
    });

    // Set before connecting so tracks subscribed during connect start silent.
    this.voiceDeafened = prefs.deafened ?? false;
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
    void this.#loadSounds();
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

  // The server marks you deafened in the call: participants can't set their own attributes (or
  // they could also rename themselves to pose as someone else).
  #publishDeafened() {
    if (!this.room) return;
    void this.#submit("/voice/deafened", "PUT", { deafened: this.voiceDeafened }).then((err) => {
      if (err) console.warn("Couldn't publish deafen state:", err);
    });
  }

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

  async leaveVoice() {
    localStorage.removeItem(VOICE_KEY);
    if (!this.room) return;
    playSound("disconnect");
    await this.room.disconnect();
    this.#resetVoice();
  }

  // Idempotent: runs from leaveVoice and again from the Disconnected event.
  #resetVoice() {
    if (this.voiceChannel) {
      this.#justLeft  = { channelId: this.voiceChannel.id, until: Date.now() + JUST_LEFT_MS };
      this.voiceRooms = this.#withoutSelfIfJustLeft(this.voiceRooms, false);
    }
    this.#audioEls.forEach((el) => el.remove());
    this.#audioEls.clear();
    this.#speakingDetector.clear();
    this.#serverSpeaking   = new Set();
    this.#wantMuted        = false;
    this.userMenu          = null;
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
    this.sounds            = [];
    this.#soundPlayed.clear();
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
    this.room?.remoteParticipants.forEach((p) => this.#applyUserAudio(p));
    this.#publishDeafened();
    this.#updateParticipants(this.room);
  }

  // ── Per-person audio ──────────────────────────────────────

  userAudioFor(identity: string): UserAudio {
    return this.userAudio.get(identity) ?? DEFAULT_USER_AUDIO;
  }

  #volumeFor(identity: string, source: Track.Source) {
    if (this.voiceDeafened) return 0;
    const audio = this.userAudioFor(identity);
    if (source === Track.Source.Microphone) return audio.muted ? 0 : audio.volume;
    if (source === Track.Source.ScreenShareAudio) return audio.streamMuted ? 0 : audio.streamVolume;
    return 1;
  }

  // LiveKit remembers these per source and applies them to tracks that arrive later.
  #applyUserAudio(p: RemoteParticipant) {
    for (const source of [Track.Source.Microphone, Track.Source.ScreenShareAudio] as const) {
      p.setVolume(this.#volumeFor(p.identity, source), source);
    }
  }

  async #loadUserAudio() {
    try {
      const res = await this.#api("/user-audio");
      if (!res.ok) return;
      const list: { target_id: number; volume: number; muted: boolean; stream_volume: number; stream_muted: boolean }[] = await res.json();
      this.userAudio = new Map(list.map((a) => [String(a.target_id), {
        volume: a.volume, muted: a.muted, streamVolume: a.stream_volume, streamMuted: a.stream_muted,
      }]));
    } catch (err) {
      console.warn("Couldn't load voice settings:", err);
    }
  }

  setUserVolume(identity: string, volume: number, kind: AudioKind = "voice") {
    const audio = this.userAudioFor(identity);
    this.#setUserAudio(identity, kind === "voice" ? { ...audio, volume } : { ...audio, streamVolume: volume });
  }

  toggleUserMute(identity: string, kind: AudioKind = "voice") {
    const audio = this.userAudioFor(identity);
    this.#setUserAudio(identity, kind === "voice" ? { ...audio, muted: !audio.muted } : { ...audio, streamMuted: !audio.streamMuted });
  }

  #setUserAudio(identity: string, audio: UserAudio) {
    this.userAudio = new Map(this.userAudio).set(identity, audio);
    const p = this.room?.remoteParticipants.get(identity);
    if (p) this.#applyUserAudio(p);

    clearTimeout(this.#userAudioSaves.get(identity));
    this.#userAudioSaves.set(identity, setTimeout(() => {
      this.#userAudioSaves.delete(identity);
      this.#api(`/user-audio/${identity}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          volume: audio.volume, muted: audio.muted, stream_volume: audio.streamVolume, stream_muted: audio.streamMuted,
        }),
      }).catch((err) => console.warn("Couldn't save voice settings:", err));
    }, USER_AUDIO_SAVE_MS));
  }

  isMe(identity: string) {
    return identity === String(this.me?.id);
  }

  // Click or right-click opens it at the pointer; Enter or Space opens it under the row.
  // Your own row has no menu: there's nothing to adjust about hearing yourself.
  openUserMenu(e: MouseEvent | KeyboardEvent, p: { identity: string; name: string }, kind: AudioKind = "voice") {
    if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    if (this.isMe(p.identity)) return;
    const at = e instanceof MouseEvent
      ? { x: e.clientX, y: e.clientY }
      : (() => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left, y: r.bottom }; })();
    this.userMenu = { identity: p.identity, name: p.name, kind, ...at };
  }

  closeUserMenu() {
    this.userMenu = null;
  }

  async #setMic(on: boolean) {
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(on);
      this.voiceMuted = !on;
      if (on) this.micBlocked = false;
      this.#applyPushToTalk(); // unmuting re-enables the track
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
      {
        identity: local.identity, name: local.name || local.identity, avatar: this.me?.avatar ?? "",
        muted: this.voiceMuted, deafened: this.voiceDeafened,
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
