// Servers: the list, the one open, its members and emotes and stickers, and what admins do to them.
import { addLibraryItem, removeLibraryItem } from "./library.ts";
import { chat } from "./chat.svelte.ts";
import { errorText } from "./net.ts";
import { t } from "./i18n.svelte.ts";
import { session } from "./session.svelte.ts";
import { ui } from "./ui.svelte.ts";
import type { Channel, Emote, Server, ServerItem, Sticker, User } from "./types.ts";

export const SERVER_KEY = "gc_server";

class Servers {
  list:    Server[]      = $state([]);
  active:  Server | null = $state(null);
  members: User[]        = $state.raw([]);
  emotes:  Emote[]       = $state.raw([]);
  stickers: Sticker[]    = $state.raw([]);
  // By lowercase name: :Kappa: and :kappa: are one emote.
  emoteMap = $derived(new Map(this.emotes.map((e) => [e.name.toLowerCase(), e])));
  // Everyone with the app open, sorted by name; pushed by the server.
  online:  User[]        = $state.raw([]);

  // The server open last time, if you still have it, or your first.
  initial() {
    const savedId = Number(localStorage.getItem(SERVER_KEY));
    return this.list.find((s) => s.id === savedId) ?? this.list[0];
  }

  async select(server: Server) {
    this.active   = server;
    ui.mainView   = "chat";
    localStorage.setItem(SERVER_KEY, String(server.id));
    await this.#load(server);
  }

  // Loads a server's channels and members, staying on the open text channel if it's still there.
  async #load(server: Server) {
    const [channels, members, emotes, stickers] = await Promise.all([
      session.api(`/servers/${server.id}/channels`),
      session.api(`/servers/${server.id}/members`),
      session.api(`/servers/${server.id}/emotes`),
      session.api(`/servers/${server.id}/stickers`),
    ]);
    if (this.active?.id !== server.id) return; // switched to another server meanwhile
    const channelList: Channel[] = channels.ok ? await channels.json() : [];
    this.members  = members.ok ? await members.json() : [];
    this.emotes   = emotes.ok ? await emotes.json() : [];
    this.stickers = stickers.ok ? await stickers.json() : [];
    await chat.showChannels(server, channelList);
  }

  // An admin changed servers, channels or members: refetch what this user can see now. False when
  // the server couldn't be asked.
  async refresh() {
    const res = await session.api("/servers");
    if (!res.ok) return false;
    this.list = await res.json();
    const open = this.list.find((s) => s.id === this.active?.id);
    if (open) {
      this.active = open;
      await this.#load(open);
    } else if (this.list.length > 0) {
      await this.select(this.list[0]);
    } else {
      this.active   = null;
      this.members  = [];
      this.emotes   = [];
      this.stickers = [];
      chat.clearChannels();
    }
    return true;
  }

  // The open server's emotes or stickers, after someone changed them.
  async loadItems(library: "emotes" | "stickers") {
    const server = this.active;
    if (!server) return;
    const res = await session.api(`/servers/${server.id}/${library}`);
    if (res.ok && this.active?.id === server.id) this[library] = await res.json();
  }

  // Signing out.
  reset() {
    this.list     = [];
    this.active   = null;
    this.members  = [];
    this.emotes   = [];
    this.stickers = [];
    this.online   = [];
  }

  // Emotes and stickers go to the server on screen. Answers with an error to show, or "".
  addItem(library: "emotes" | "stickers", name: string, file: File) {
    return addLibraryItem(this.active?.id, library, name, file);
  }

  removeItem(library: "emotes" | "stickers", item: ServerItem) {
    return removeLibraryItem(this.active?.id, library, item);
  }

  // ── Admin: servers and members ────────────────────────────

  async create(name: string): Promise<string> {
    const res = await session.api("/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    if (!res?.ok) return res ? await errorText(res) : t("Can't reach the server.");
    const created: Server = await res.json();
    this.list = [...this.list.filter((s) => s.id !== created.id), created];
    await this.select(created);
    return "";
  }

  rename(id: number, name: string) {
    return session.submit(`/servers/${id}`, "PATCH", { name });
  }

  delete(id: number) {
    return session.submit(`/servers/${id}`, "DELETE");
  }

  setIcon(id: number, file: File) {
    const form = new FormData();
    form.append("file", file);
    return session.submit(`/servers/${id}/icon`, "PUT", form);
  }

  removeIcon(id: number) {
    return session.submit(`/servers/${id}/icon`, "DELETE");
  }

  addMember(serverId: number, userId: number) {
    return session.submit(`/servers/${serverId}/members/${userId}`, "PUT");
  }

  removeMember(serverId: number, userId: number) {
    return session.submit(`/servers/${serverId}/members/${userId}`, "DELETE");
  }

  // Everyone who has signed in, for adding people to a server.
  async allUsers(): Promise<User[]> {
    const res = await session.api("/users").catch(() => null);
    return res?.ok ? res.json() : [];
  }
}

export const servers = new Servers();
