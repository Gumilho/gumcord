import { beforeEach, describe, expect, it, vi } from "vitest";
import { admin, channel, json, me, message, mockApi, server } from "./test-utils.ts";

// The live connection, the call and the soundboard are stand-ins: this is about what the app tells them.
const live = vi.hoisted(() => ({ onEvent: null as null | ((e: unknown) => void) }));
const socket = vi.hoisted(() => ({
  connect: vi.fn((fn: (e: unknown) => void) => { live.onEvent = fn; }),
  close: vi.fn(), send: vi.fn(() => true),
}));
const voice = vi.hoisted(() => ({
  restore: vi.fn(), setRooms: vi.fn(), disconnect: vi.fn(async () => {}), destroy: vi.fn(), leave: vi.fn(async () => {}),
  channel: null as null | { id: number; server_id: number }, server: null as null | { id: number },
}));
const soundboard = vi.hoisted(() => ({ load: vi.fn(async () => {}) }));
const preloadSounds = vi.hoisted(() => vi.fn());
vi.mock("./socket.svelte.ts", () => ({ socket }));
vi.mock("./voice.svelte.ts", () => ({ voice, VOICE_KEY: "gc_voice" }));
vi.mock("./soundboard.svelte.ts", () => ({ soundboard }));
vi.mock("./sounds.ts", () => ({ playSound: vi.fn(), playClip: vi.fn(), preloadSounds }));

import { app } from "./app.svelte.ts";
import { chat } from "./chat.svelte.ts";
import { servers } from "./servers.svelte.ts";
import { session } from "./session.svelte.ts";
import { userAudio } from "./userAudio.svelte.ts";

function backend(over: Record<string, () => Response | Promise<Response>> = {}) {
  return mockApi({
    "GET /me": () => json(me),
    "GET /servers": () => json([server(1), server(2)]),
    "GET /servers/1/channels": () => json([channel(10, 1), channel(11, 1, "voice")]),
    "GET /servers/1/members": () => json([me]),
    "GET /servers/1/emotes": () => json([]),
    "GET /servers/1/stickers": () => json([]),
    "GET /channels/10/messages": () => json([message(1, 10)]),
    "GET /user-audio": () => json([]),
    "GET /channel-mutes": () => json([10]),
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  live.onEvent = null;
  voice.channel = null;
  voice.server = null;
  session.me = null;
  session.signedOut = false;
  session.bootError = "";
  session.booted = false;
  servers.reset();
  chat.reset();
  userAudio.reset();
});

describe("boot", () => {
  it("brings up everything for a signed-in user, then says it's ready", async () => {
    backend();
    expect(session.booted).toBe(false);
    await app.boot();
    expect(session.me).toEqual(me);
    expect(session.booted).toBe(true);
    expect(session.bootError).toBe("");
    expect(servers.list.map((s) => s.id)).toEqual([1, 2]);
    expect(servers.active?.id).toBe(1);
    expect(chat.activeChannel?.id).toBe(10);
    expect(chat.messages).toHaveLength(1);
    expect(chat.mutedChannels.has(10)).toBe(true);
    expect(preloadSounds).toHaveBeenCalledOnce();
    expect(socket.connect).toHaveBeenCalledOnce();
    expect(voice.restore).toHaveBeenCalledOnce();
  });

  it("opens the server you had open last time", async () => {
    backend({
      "GET /servers/2/channels": () => json([channel(20, 2)]),
      "GET /servers/2/members": () => json([me]),
      "GET /servers/2/emotes": () => json([]),
      "GET /servers/2/stickers": () => json([]),
      "GET /channels/20/messages": () => json([]),
    });
    localStorage.setItem("gc_server", "2");
    await app.boot();
    expect(servers.active?.id).toBe(2);
  });

  it("works for a user with no servers yet", async () => {
    backend({ "GET /servers": () => json([]) });
    await app.boot();
    expect(session.booted).toBe(true);
    expect(servers.active).toBeNull();
    expect(socket.connect).toHaveBeenCalledOnce(); // so they hear when an admin adds them
  });

  it("clears the signed-out flag", async () => {
    backend();
    localStorage.setItem("gc_signed_out", "1");
    session.signedOut = true;
    await app.boot();
    expect(localStorage.getItem("gc_signed_out")).toBeNull();
    expect(session.signedOut).toBe(false);
  });

  it("sends someone with no session to sign in, without starting anything", async () => {
    backend({ "GET /me": () => new Response("", { status: 401 }), "GET /servers": () => new Response("", { status: 401 }) });
    localStorage.setItem("gc_signed_out", "1");
    await app.boot();
    expect(session.signedOut).toBe(true);
    expect(session.me).toBeNull();
    expect(session.booted).toBe(false);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(voice.restore).not.toHaveBeenCalled();
  });

  it("says when the backend can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await app.boot();
    expect(session.bootError).toBe("Cannot reach server. Is the backend running?");
    expect(session.booted).toBe(false);
  });

  it("says when the backend is broken", async () => {
    backend({ "GET /servers": () => new Response("", { status: 503 }) });
    await app.boot();
    expect(session.bootError).toBe("Server error (503).");
    expect(session.me).toBeNull();
    backend({ "GET /me": () => new Response("", { status: 500 }) });
    await app.boot();
    expect(session.bootError).toBe("Server error (500).");
  });

  it("lands on the error screen, rather than hanging, when something unexpected goes wrong", async () => {
    backend({ "GET /servers/1/channels": () => { throw new Error("boom"); } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await app.boot();
    expect(session.bootError).toBe("Couldn't load Gumcord: boom");
    expect(session.booted).toBe(false);
  });

  it("can be retried after an error", async () => {
    backend({ "GET /servers": () => new Response("", { status: 503 }) });
    await app.boot();
    backend();
    await app.boot();
    expect(session.bootError).toBe("");
    expect(session.booted).toBe(true);
  });
});

describe("live events", () => {
  beforeEach(async () => {
    backend();
    await app.boot();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  const fire = (e: unknown) => live.onEvent!(e);

  it("adds a new message to the open channel", () => {
    fire(message(2, 10));
    expect(chat.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("applies edits and deletes", () => {
    fire({ type: "message_edited", id: 1, content: "edited", edited_at: "2026-01-01 00:01:00" });
    expect(chat.messages[0].content).toBe("edited");
    fire({ type: "message_deleted", id: 1 });
    expect(chat.messages).toEqual([]);
  });

  it("shows who's online", () => {
    fire({ type: "online", users: [me, admin] });
    expect(servers.online).toEqual([me, admin]);
  });

  it("hands who's in each voice channel to the call", () => {
    const channels = { "11": [] };
    fire({ type: "voice", channels });
    expect(voice.setRooms).toHaveBeenCalledWith(channels);
  });

  it("reloads emotes and stickers, for the open server only", async () => {
    const api = backend({ "GET /servers/1/emotes": () => json([{ id: 1, name: "a", url: "/files/emote-a.png", created_by: 1 }]) });
    fire({ type: "emotes", server_id: 2 });
    fire({ type: "stickers", server_id: 99 });
    await Promise.resolve();
    expect(api.paths()).toEqual([]);
    fire({ type: "emotes", server_id: 1 });
    await vi.waitFor(() => expect(servers.emotes).toHaveLength(1));
  });

  it("reloads the soundboard when it's the sounds of your call's server", () => {
    voice.channel = { id: 11, server_id: 1 };
    fire({ type: "sounds", server_id: 2 });
    expect(soundboard.load).not.toHaveBeenCalled();
    fire({ type: "sounds", server_id: 1 });
    expect(soundboard.load).toHaveBeenCalledOnce();
    voice.channel = null;
    fire({ type: "sounds", server_id: 1 });
    expect(soundboard.load).toHaveBeenCalledOnce();
  });

  it("ignores events it doesn't know", () => {
    expect(() => fire({ type: "something-new" })).not.toThrow();
  });

  describe("when servers, channels or members changed", () => {
    it("refreshes, and keeps the call", async () => {
      backend({ "GET /servers": () => json([server(1, "renamed")]) });
      voice.channel = { id: 11, server_id: 1 };
      voice.server = { id: 1 };
      fire({ type: "servers" });
      await vi.waitFor(() => expect(servers.active?.name).toBe("renamed"));
      expect(voice.leave).not.toHaveBeenCalled();
    });

    it("leaves the call when you're removed from its server", async () => {
      backend({ "GET /servers": () => json([server(2)]), "GET /servers/2/channels": () => json([]), "GET /servers/2/members": () => json([]), "GET /servers/2/emotes": () => json([]), "GET /servers/2/stickers": () => json([]) });
      voice.channel = { id: 11, server_id: 1 };
      voice.server = null; // no longer in your list
      fire({ type: "servers" });
      await vi.waitFor(() => expect(voice.leave).toHaveBeenCalledOnce());
    });

    it("doesn't touch the call if the servers couldn't be fetched", async () => {
      backend({ "GET /servers": () => new Response("", { status: 500 }) });
      voice.channel = { id: 11, server_id: 1 };
      voice.server = null;
      fire({ type: "servers" });
      await new Promise((r) => setTimeout(r, 20));
      expect(voice.leave).not.toHaveBeenCalled();
    });

    it("has nothing to leave when you weren't in a call", async () => {
      backend({ "GET /servers": () => json([]) });
      fire({ type: "servers" });
      await vi.waitFor(() => expect(servers.list).toEqual([]));
      expect(voice.leave).not.toHaveBeenCalled();
    });
  });
});

describe("signing out", () => {
  it("ends everything, forgets where you were, and shows the sign-in screen", async () => {
    const api = backend({ "POST /auth/logout": () => new Response(null, { status: 204 }) });
    await app.boot();
    localStorage.setItem("gc_voice", "{}");
    await app.logout();

    expect(api.paths()).toContain("POST /auth/logout");
    expect(session.me).toBeNull();
    expect(session.signedOut).toBe(true);
    expect(session.booted).toBe(false);
    expect(localStorage.getItem("gc_signed_out")).toBe("1");
    for (const key of ["gc_server", "gc_channels", "gc_voice"]) expect(localStorage.getItem(key)).toBeNull();
    expect(voice.disconnect).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalled();
    expect(servers.list).toEqual([]);
    expect(servers.active).toBeNull();
    expect(chat.channels).toEqual([]);
    expect(chat.mutedChannels.size).toBe(0);
  });

  it("signs out here even if the server can't be told", async () => {
    backend();
    await app.boot();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await app.logout();
    expect(session.signedOut).toBe(true);
    expect(session.me).toBeNull();
  });

  it("leaves the call before closing the live connection", async () => {
    backend();
    await app.boot();
    const order: string[] = [];
    voice.disconnect.mockImplementationOnce(async () => { order.push("voice"); });
    socket.close.mockImplementationOnce(() => { order.push("socket"); });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await app.logout();
    expect(order).toEqual(["voice", "socket"]);
  });
});

describe("a session that ends while the app is open", () => {
  it("is cleaned up as if you'd signed out, and shows the sign-in screen", async () => {
    backend();
    await app.boot();
    localStorage.setItem("gc_signed_out", "1"); // so it shows the screen instead of redirecting
    mockApi({ "GET /channel-mutes": () => new Response("", { status: 401 }) });
    await session.api("/channel-mutes");
    await vi.waitFor(() => expect(session.signedOut).toBe(true));
    expect(session.me).toBeNull();
    expect(voice.disconnect).toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
    expect(servers.list).toEqual([]);
  });
});

describe("destroy", () => {
  it("closes the connection and leaves the call", () => {
    app.destroy();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(voice.destroy).toHaveBeenCalledOnce();
  });
});
