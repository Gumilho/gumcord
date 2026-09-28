import { Room, RoomEvent, Track, type RoomOptions } from "livekit-client";

// rtcConfig is valid at runtime but missing from the SDK's exported types
type RoomOptionsWithRtc = RoomOptions & { rtcConfig?: RTCConfiguration };
import { API_BASE, LIVEKIT_WS } from "./config.js";

interface Channel {
  id: number;
  name: string;
  kind: string;
}
interface Message {
  id: number;
  channel_id: number;
  username: string;
  content: string;
  created_at: string;
}
interface VoiceParticipant {
  identity: string;
  speaking: boolean;
}

class GumcordStore {
  // auth
  token = $state(localStorage.getItem("gc_token") ?? "");
  username = $state(localStorage.getItem("gc_username") ?? "");
  loginError = $state("");
  loginInput = $state("");
  passInput = $state("");

  // channels + messages
  channels: Channel[] = $state([]);
  activeChannel: Channel | null = $state(null);
  messages: Message[] = $state([]);
  draft = $state("");

  // voice
  room: Room | null = $state(null);
  voiceMuted = $state(false);
  voiceParticipants: VoiceParticipant[] = $state([]);

  // private — not needed in templates
  #ws: WebSocket | null = null;
  #audioEls: Map<string, HTMLAudioElement> = new Map();

  // ── Auth ──────────────────────────────────────────────────

  async login() {
    this.loginError = "";
    let res;
    try {
      res = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.loginInput,
          password: this.passInput,
        }),
      });
    } catch {
      this.loginError = "Cannot reach server.";
      return;
    }
    if (!res.ok) {
      this.loginError = "Wrong password.";
      return;
    }

    const data = await res.json();
    this.token = data.token;
    this.username = this.loginInput;
    localStorage.setItem("gc_token", this.token);
    localStorage.setItem("gc_username", this.username);
    await this.boot();
  }

  async logout() {
    await this.leaveVoice();
    this.#ws?.close();
    this.#ws = null;
    this.token = "";
    this.username = "";
    this.channels = [];
    this.messages = [];
    this.activeChannel = null;
    localStorage.removeItem("gc_token");
    localStorage.removeItem("gc_username");
  }

  // ── Boot ──────────────────────────────────────────────────

  async boot() {
    let res;
    try {
      res = await fetch(`${API_BASE}/channels`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch {
      await this.logout();
      return;
    }
    if (!res.ok) {
      await this.logout();
      return;
    }

    this.channels = await res.json();
    const first = this.channels.find((c) => c.kind === "text");
    if (first) await this.selectChannel(first);
    this.#openWS();
  }

  destroy() {
    this.#ws?.close();
    this.#audioEls.forEach((el) => el.remove());
    this.#audioEls.clear();
    this.room?.disconnect();
  }

  // ── Channels / messages ───────────────────────────────────

  async selectChannel(ch: Channel) {
    if (ch.kind === "voice") return;
    this.activeChannel = ch;
    const res = await fetch(`${API_BASE}/channels/${ch.id}/messages`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    this.messages = res.ok ? await res.json() : [];
  }

  sendMessage() {
    const content = this.draft.trim();
    if (
      !content ||
      !this.activeChannel ||
      !this.#ws ||
      this.#ws.readyState !== WebSocket.OPEN
    )
      return;
    this.#ws.send(
      JSON.stringify({ channel_id: this.activeChannel.id, content }),
    );
    this.draft = "";
  }

  // ── WebSocket ─────────────────────────────────────────────

  #openWS() {
    if (this.#ws) return;
    this.#ws = new WebSocket(
      `${API_BASE.replace("http", "ws")}/ws?token=${this.token}`,
    );
    this.#ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (this.activeChannel && msg.channel_id === this.activeChannel.id) {
        this.messages = [...this.messages, msg];
      }
    };
    this.#ws.onclose = () => {
      this.#ws = null;
    };
  }

  // ── Voice ─────────────────────────────────────────────────

  async joinVoice(ch: Channel) {
    if (this.room) return;
    const res = await fetch(`${API_BASE}/voice/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ room: ch.name }),
    });
    if (!res.ok) return;
    const { token: lkToken } = await res.json();

    const r = new Room({
      rtcConfig: {
        iceServers: [
          {
            urls: `turn:${new URL(API_BASE).hostname}:3478?transport=tcp`,
            username: "livekit",
            credential: "turnpass",
          },
        ],
      },
    } as RoomOptionsWithRtc);

    r.on(RoomEvent.ParticipantConnected, () => this.#updateParticipants(r));
    r.on(RoomEvent.ParticipantDisconnected, () => this.#updateParticipants(r));

    r.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
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
      this.room = null;
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
    this.room = null;
    this.voiceMuted = false;
    this.voiceParticipants = [];
  }

  async toggleMute() {
    if (!this.room) return;
    this.voiceMuted = !this.voiceMuted;
    await this.room.localParticipant.setMicrophoneEnabled(!this.voiceMuted);
  }

  #updateParticipants(r: Room) {
    const current = new Map(
      this.voiceParticipants.map((p) => [p.identity, p.speaking]),
    );
    this.voiceParticipants = [
      r.localParticipant,
      ...Array.from(r.remoteParticipants.values()),
    ].map((p) => ({
      identity: p.identity,
      speaking: current.get(p.identity) ?? false,
    }));
  }
}

export const store = new GumcordStore();
