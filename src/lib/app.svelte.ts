// Starting up, signing out, and what the live connection's events mean. The one place that knows
// about all the stores; the stores only know about the ones beneath them.
import { chat, CHANNEL_KEY } from "./chat.svelte.ts";
import { t } from "./i18n.svelte.ts";
import { servers, SERVER_KEY } from "./servers.svelte.ts";
import { session, SIGNED_OUT_KEY } from "./session.svelte.ts";
import { socket } from "./socket.svelte.ts";
import { soundboard } from "./soundboard.svelte.ts";
import { preloadSounds } from "./sounds.ts";
import { userAudio } from "./userAudio.svelte.ts";
import { voice, VOICE_KEY } from "./voice.svelte.ts";
import { fetchWithTimeout } from "./net.ts";
import type { Library, Message, User, VoiceMember } from "./types.ts";

// Everything the server can push over the live connection.
type LiveEvent =
  | Message
  | { type: "voice"; channels: Record<string, VoiceMember[]> }
  | { type: "online"; users: User[] }
  | { type: "servers" }
  | { type: Library; server_id: number }
  | { type: "message_edited"; id: number; content: string; edited_at: string }
  | { type: "message_deleted"; id: number };

class App {
  constructor() {
    // A 401 from any request: the session ended elsewhere.
    session.onExpired = () => this.#endSession();
  }

  async boot() {
    session.bootError = "";
    try {
      await this.#boot();
    } catch (err) {
      // Anything unexpected must land on the error screen, never leave the splash up forever.
      console.error("Boot failed:", err);
      session.bootError = t("Couldn't load Gumcord: {error}", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async #boot() {
    let me: Response, list: Response;
    try {
      [me, list] = await Promise.all([session.api("/me"), session.api("/servers")]);
    } catch {
      session.bootError = t("Cannot reach server. Is the backend running?");
      return;
    }
    if (me.status === 401) { session.needSignIn(); return; }
    if (!me.ok || !list.ok) { session.bootError = t("Server error ({status}).", { status: me.ok ? list.status : me.status }); return; }

    session.me        = await me.json();
    session.signedOut = false;
    localStorage.removeItem(SIGNED_OUT_KEY);
    servers.list      = await list.json();
    const server      = servers.initial();
    // Everything below only needs to know who you are, so it runs while the server loads.
    const loading = server ? servers.select(server) : undefined;
    void preloadSounds();
    void userAudio.load();
    void chat.loadMuted();
    socket.connect((data) => this.#onEvent(data as LiveEvent));
    voice.restore();
    await loading;
    session.booted = true;
  }

  async logout() {
    await fetchWithTimeout("/api/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem(SERVER_KEY);
    localStorage.removeItem(CHANNEL_KEY);
    localStorage.removeItem(VOICE_KEY);
    localStorage.setItem(SIGNED_OUT_KEY, "1");
    await this.#endSession();
    session.signedOut = true;
  }

  async #endSession() {
    session.me = null; // before closing the socket, so it doesn't reconnect
    // Leave without clearing the saved voice session, so signing back in rejoins.
    await voice.disconnect();
    socket.close();
    servers.reset();
    chat.reset();
    userAudio.reset();
    session.bootError = "";
    session.booted    = false;
  }

  // The page is going away.
  destroy() {
    socket.close();
    voice.destroy();
  }

  #onEvent(data: LiveEvent) {
    if (!("type" in data)) {
      chat.receive(data);
      return;
    }
    switch (data.type) {
      case "voice":           voice.setRooms(data.channels); break;
      case "online":          servers.online = data.users; break;
      case "servers":         void this.#refreshServers(); break;
      case "message_edited":  chat.edited(data.id, data.content, data.edited_at); break;
      case "message_deleted": chat.deleted(data.id); break;
      case "emotes":
      case "stickers":
        if (data.server_id === servers.active?.id) void servers.loadItems(data.type);
        break;
      case "sounds":
        if (data.server_id === voice.channel?.server_id) void soundboard.load();
        break;
    }
  }

  // An admin changed servers, channels or members.
  async #refreshServers() {
    if (!(await servers.refresh())) return;
    // Removed from the server of your call: the server also ends it on LiveKit's side.
    if (voice.channel && !voice.server) await voice.leave();
  }
}

export const app = new App();
