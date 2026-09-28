import { Room, RoomEvent, Track, type RoomOptions } from "livekit-client";
import { API_BASE, LIVEKIT_WS } from "./config.js";

// rtcConfig is valid at runtime but missing from the SDK's exported types
type RoomOptionsWithRtc = RoomOptions & { rtcConfig?: RTCConfiguration };

interface Channel          { id: number; name: string; kind: string; }
interface Message          { id: number; channel_id: number; username: string; content: string; created_at: string; }
interface VoiceParticipant { identity: string; speaking: boolean; }

const WS_RECONNECT_BASE = 1_000;  // ms
const WS_RECONNECT_MAX  = 30_000; // ms

class GumcordStore {
  // auth
  token      = $state(localStorage.getItem("gc_token") ?? "");
  username   = $state(localStorage.getItem("gc_username") ?? "");
  loginError = $state("");
  loginInput = $state("");
  passInput  = $state("");

  // boot
  bootError = $state("");

  // channels + messages
  channels:      Channel[]      = $state([]);
  activeChannel: Channel | null = $state(null);
  messages:      Message[]      = $state([]);
  draft = $state("");

  // voice
  room:              Room | null          = $state(null);
  voiceMuted                              = $state(false);
  voiceParticipants: VoiceParticipant[]   = $state([]);

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
    localStorage.removeItem("gc_token");
    localStorage.removeItem("gc_username");
  }

  // ── Boot ──────────────────────────────────────────────────

  async boot() {
    this.bootError = "";
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/channels`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch {
      this.bootError = "Cannot reach server. Is the backend running?";
      return;
    }
    if (res.status === 401) { await this.logout(); return; }
    if (!res.ok) { this.bootError = `Server error (${res.status}).`; return; }

    this.channels = await res.json();
    const first = this.channels.find((c) => c.kind === "text");
    if (first) await this.selectChannel(first);
    this.#openWS();
  }

  destroy() {
    clearTimeout(this.#wsRetryTimer ?? undefined);
    this.#ws?.close();
    this.#audioEls.forEach((el) => el.remove());
    this.#audioEls.clear();
    this.room?.disconnect();
  }

  // ── Channels / messages ───────────────────────────────────

  async selectChannel(ch: Channel) {
    if (ch.kind === "voice") return;

    // Cancel any in-flight fetch for a previous channel
    this.#fetchAbort?.abort();
    this.#fetchAbort = new AbortController();
    this.activeChannel = ch;

    try {
      const res = await fetch(`${API_BASE}/channels/${ch.id}/messages`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: this.#fetchAbort.signal,
      });
      this.messages = res.ok ? await res.json() : [];
    } catch (err) {
      if ((err as Error).name !== "AbortError") this.messages = [];
    }
  }

  sendMessage() {
    const content = this.draft.trim();
    if (!content || !this.activeChannel || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify({ channel_id: this.activeChannel.id, content }));
    this.draft = "";
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

  async joinVoice(ch: Channel) {
    if (this.room) return;
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

    r.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el  = track.attach();
        const sid = track.sid ?? track.source;
        this.#audioEls.set(sid, el);
        document.body.appendChild(el);
      }
      this.#updateParticipants(r);
    });

    r.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        track.detach();
        const sid = track.sid ?? track.source;
        this.#audioEls.get(sid)?.remove();
        this.#audioEls.delete(sid);
      }
      this.#updateParticipants(r);
    });

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const speaking = new Set(speakers.map((p) => p.identity));
      this.voiceParticipants = this.voiceParticipants.map((p) => ({
        ...p,
        speaking: speaking.has(p.identity),
      }));
    });

    r.on(RoomEvent.Disconnected, () => {
      this.#audioEls.forEach((el) => el.remove());
      this.#audioEls.clear();
      this.room             = null;
      this.voiceParticipants = [];
    });

    await r.connect(LIVEKIT_WS, lkToken);
    await r.localParticipant.setMicrophoneEnabled(true);
    this.room = r;
    this.#updateParticipants(r);
  }

  async leaveVoice() {
    if (!this.room) return;
    this.#audioEls.forEach((el) => el.remove());
    this.#audioEls.clear();
    await this.room.disconnect();
    this.room              = null;
    this.voiceMuted        = false;
    this.voiceParticipants = [];
  }

  async toggleMute() {
    if (!this.room) return;
    this.voiceMuted = !this.voiceMuted;
    await this.room.localParticipant.setMicrophoneEnabled(!this.voiceMuted);
  }

  #updateParticipants(r: Room) {
    const current = new Map(this.voiceParticipants.map((p) => [p.identity, p.speaking]));
    this.voiceParticipants = [
      r.localParticipant,
      ...Array.from(r.remoteParticipants.values()),
    ].map((p) => ({ identity: p.identity, speaking: current.get(p.identity) ?? false }));
  }
}

export const store = new GumcordStore();
