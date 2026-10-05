// Text channels: which one is open and its messages, what you're typing and attaching, and the
// new-message ping.
import { t } from "./i18n.svelte.ts";
import { playSound } from "./sounds.ts";
import { UPLOAD_TIMEOUT_MS } from "./net.ts";
import { session } from "./session.svelte.ts";
import { socket } from "./socket.svelte.ts";
import { ui } from "./ui.svelte.ts";
import type { Attachment, Channel, ChannelKind, Message, Server, Sticker } from "./types.ts";

// The last text channel read in each server: { [serverId]: channelId }.
export const CHANNEL_KEY = "gc_channels";

// A burst of new messages pings once.
const PING_GAP_MS = 1_000;

class Chat {
  channels:      Channel[]      = $state([]);
  activeChannel: Channel | null = $state(null);
  messages:      Message[]      = $state([]);
  // The open channel's messages are on their way.
  loading = $state(false);
  draft = $state("");
  pendingAttachment: Attachment | null = $state(null);
  uploading   = $state(false);
  uploadError = $state("");
  // Channels whose new messages make no sound. Replaced wholesale on change.
  mutedChannels: ReadonlySet<number> = $state.raw(new Set());

  #fetchAbort: AbortController | null = null;
  // When a new message last pinged.
  #lastPing = 0;

  // ── Channels ──────────────────────────────────────────────

  // A server's channels have loaded: stays on the open text channel if it's still there, otherwise
  // opens the one read last time, or the first.
  async showChannels(server: Server, channels: Channel[]) {
    this.channels = channels;
    const current = channels.find((c) => c.id === this.activeChannel?.id);
    if (current) {
      this.activeChannel = current; // picks up a rename
      return;
    }
    const savedId = this.#savedChannels()[server.id];
    const text = channels.find((c) => c.kind === "text" && c.id === savedId)
              ?? channels.find((c) => c.kind === "text");
    if (text) {
      await this.selectChannel(text);
    } else {
      this.activeChannel = null;
      this.messages      = [];
    }
  }

  #savedChannels(): Record<number, number> {
    try {
      return JSON.parse(localStorage.getItem(CHANNEL_KEY) ?? "{}") ?? {};
    } catch {
      return {};
    }
  }

  async selectChannel(ch: Channel) {
    if (ch.kind === "voice") return;

    // Cancel any in-flight fetch for a previous channel
    this.#fetchAbort?.abort();
    const request = (this.#fetchAbort = new AbortController());
    this.loading           = true;
    this.activeChannel     = ch;
    ui.mainView            = "chat";
    this.pendingAttachment = null;
    this.uploadError       = "";
    localStorage.setItem(CHANNEL_KEY, JSON.stringify({ ...this.#savedChannels(), [ch.server_id]: ch.id }));

    try {
      const res = await session.api(`/channels/${ch.id}/messages`, { signal: request.signal });
      this.messages = res.ok ? await res.json() : [];
    } catch (err) {
      if ((err as Error).name !== "AbortError") this.messages = [];
    } finally {
      if (this.#fetchAbort === request) this.loading = false; // not if another channel took over
    }
  }

  // Admins only. Shows up for everyone through the server's live update.
  async createChannel(serverId: number, name: string, kind: ChannelKind) {
    const res = await session.api(`/servers/${serverId}/channels`, {
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
    return session.submit(`/channels/${id}`, "PATCH", { name });
  }

  deleteChannel(id: number) {
    return session.submit(`/channels/${id}`, "DELETE");
  }

  // No server is open (any more): nothing to show.
  clearChannels() {
    this.#fetchAbort?.abort();
    this.loading       = false;
    this.channels      = [];
    this.activeChannel = null;
    this.messages      = [];
  }

  // Signing out.
  reset() {
    this.clearChannels();
    this.mutedChannels = new Set();
  }

  // ── Messages ──────────────────────────────────────────────

  async uploadFile(file: File) {
    this.uploadError = "";
    this.uploading   = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await session.api("/upload", { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
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
    return session.submit(`/messages/${id}`, "PATCH", { content });
  }

  deleteMessage(id: number) {
    return session.submit(`/messages/${id}`, "DELETE");
  }

  canEdit(msg: Message) {
    return msg.author_id === session.me?.id;
  }

  canDelete(msg: Message) {
    return msg.author_id === session.me?.id || !!session.me?.admin;
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
    if (!this.activeChannel) return false;
    return socket.send({
      channel_id:      this.activeChannel.id,
      content,
      attachment_url:  attachmentUrl,
      attachment_type: attachmentType,
    });
  }

  // ── Live updates ──────────────────────────────────────────

  // A new message, in any channel you can see.
  receive(msg: Message) {
    if (this.activeChannel && msg.channel_id === this.activeChannel.id) {
      this.messages = [...this.messages, msg];
    }
    this.#pingFor(msg);
  }

  edited(id: number, content: string, editedAt: string) {
    this.messages = this.messages.map((m) => (m.id === id ? { ...m, content, edited_at: editedAt } : m));
  }

  deleted(id: number) {
    this.messages = this.messages.filter((m) => m.id !== id);
  }

  // ── New-message sound ─────────────────────────────────────

  // Someone else's message pings, in any channel, unless it's muted or you're reading it right now.
  #pingFor(msg: Message) {
    if (msg.author_id === session.me?.id || this.mutedChannels.has(msg.channel_id)) return;
    if (ui.mainView === "chat" && this.activeChannel?.id === msg.channel_id && document.hasFocus()) return;
    const now = Date.now();
    if (now - this.#lastPing < PING_GAP_MS) return;
    this.#lastPing = now;
    playSound("ping");
  }

  async loadMuted() {
    try {
      const res = await session.api("/channel-mutes");
      if (res.ok) this.mutedChannels = new Set(await res.json());
    } catch (err) {
      console.warn("Couldn't load muted channels:", err);
    }
  }

  // Saved on the server, so it follows you to your other devices. Undone if saving fails.
  toggleMute(id: number) {
    const muted = !this.mutedChannels.has(id);
    this.#setMuted(id, muted);
    session.api(`/channel-mutes/${id}`, { method: muted ? "PUT" : "DELETE" })
      .then((res) => { if (!res.ok) throw new Error(`status ${res.status}`); })
      .catch((err) => {
        console.warn("Couldn't save channel mute:", err);
        this.#setMuted(id, !muted);
      });
  }

  #setMuted(id: number, muted: boolean) {
    const next = new Set(this.mutedChannels);
    if (muted) next.add(id);
    else next.delete(id);
    this.mutedChannels = next;
  }
}

export const chat = new Chat();
