import { beforeEach, describe, expect, it, vi } from "vitest";
import { channel, json, me, admin, message, mockApi } from "./test-utils.ts";

const playSound = vi.fn();
vi.mock("./sounds.ts", () => ({ playSound: (...a: unknown[]) => playSound(...a), playClip: vi.fn(), preloadSounds: vi.fn() }));
const send = vi.fn((_data: unknown) => true);
vi.mock("./socket.svelte.ts", () => ({ socket: { send: (d: unknown) => send(d), connect: vi.fn(), close: vi.fn() } }));

import { chat } from "./chat.svelte.ts";
import { session } from "./session.svelte.ts";
import { ui } from "./ui.svelte.ts";

// Pings only once a second, so each test starts a good while after the last.
let clock = 1_700_000_000_000;

beforeEach(() => {
  chat.reset();
  chat.draft = "";
  chat.pendingAttachment = null;
  chat.uploadError = "";
  session.me = me;
  ui.mainView = "chat";
  playSound.mockClear();
  send.mockReset().mockReturnValue(true);
  vi.useFakeTimers();
  clock += 60_000;
  vi.setSystemTime(clock);
});

describe("opening channels", () => {
  it("loads the messages of the channel you pick", async () => {
    mockApi({ "GET /channels/1/messages": () => json([message(1, 1), message(2, 1)]) });
    await chat.selectChannel(channel(1));
    expect(chat.activeChannel?.id).toBe(1);
    expect(chat.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(ui.mainView).toBe("chat");
  });

  it("shows the chat again when you pick a channel from the call view", async () => {
    mockApi({ "GET /channels/1/messages": () => json([]) });
    ui.mainView = "call";
    await chat.selectChannel(channel(1));
    expect(ui.mainView).toBe("chat");
  });

  it("ignores voice channels", async () => {
    const api = mockApi({});
    await chat.selectChannel(channel(2, 1, "voice"));
    expect(chat.activeChannel).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it("drops what you were attaching when you move to another channel", async () => {
    mockApi({ "GET /channels/1/messages": () => json([]) });
    chat.pendingAttachment = { url: "/files/x.png", type: "image", name: "x.png" };
    chat.uploadError = "Upload failed.";
    await chat.selectChannel(channel(1));
    expect(chat.pendingAttachment).toBeNull();
    expect(chat.uploadError).toBe("");
  });

  it("shows nothing rather than stale messages when they can't be loaded", async () => {
    mockApi({ "GET /channels/1/messages": () => json([message(1, 1)]) });
    await chat.selectChannel(channel(1));
    mockApi({ "GET /channels/2/messages": () => new Response("nope", { status: 500 }) });
    await chat.selectChannel(channel(2));
    expect(chat.messages).toEqual([]);
  });

  it("a slow answer for the channel you left can't replace the one you're in", async () => {
    let finishFirst!: (r: Response) => void;
    const api = mockApi({
      // Like a real request, it fails once aborted; if it still got an answer in, that must not win.
      "GET /channels/1/messages": ({ signal }) => new Promise<Response>((resolve, reject) => {
        finishFirst = resolve;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
      "GET /channels/2/messages": () => json([message(9, 2)]),
    });
    const first = chat.selectChannel(channel(1));
    await chat.selectChannel(channel(2));
    finishFirst(json([message(1, 1)]));
    await first;
    expect(api.paths()).toEqual(["GET /channels/1/messages", "GET /channels/2/messages"]);
    expect(chat.activeChannel?.id).toBe(2);
    expect(chat.messages.map((m) => m.id)).toEqual([9]);
  });

  it("remembers the last channel read in each server", async () => {
    mockApi({ "GET /channels/3/messages": () => json([]), "GET /channels/5/messages": () => json([]) });
    await chat.selectChannel(channel(3, 1));
    await chat.selectChannel(channel(5, 2));
    expect(JSON.parse(localStorage.getItem("gc_channels")!)).toEqual({ 1: 3, 2: 5 });
  });
});

describe("loading", () => {
  it("is on while a channel's messages are coming, and off once they've arrived", async () => {
    let answer!: (r: Response) => void;
    mockApi({ "GET /channels/1/messages": () => new Promise<Response>((r) => (answer = r)) });
    expect(chat.loading).toBe(false);
    const opening = chat.selectChannel(channel(1));
    expect(chat.loading).toBe(true);
    answer(json([message(1, 1)]));
    await opening;
    expect(chat.loading).toBe(false);
    expect(chat.messages).toHaveLength(1);
  });

  it("is off after a failure too", async () => {
    mockApi({ "GET /channels/1/messages": () => new Response("no", { status: 500 }) });
    await chat.selectChannel(channel(1));
    expect(chat.loading).toBe(false);
  });

  it("stays on while the channel you moved to is still loading, not turned off by the one you left", async () => {
    let answerSecond!: (r: Response) => void;
    mockApi({
      "GET /channels/1/messages": ({ signal }) => new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
      "GET /channels/2/messages": () => new Promise<Response>((r) => (answerSecond = r)),
    });
    const first = chat.selectChannel(channel(1));
    const second = chat.selectChannel(channel(2));
    await first; // the first was cancelled
    expect(chat.loading).toBe(true);
    answerSecond(json([]));
    await second;
    expect(chat.loading).toBe(false);
  });

  it("is off when the channels are cleared mid-load, and the late answer is dropped", async () => {
    mockApi({
      "GET /channels/1/messages": ({ signal }) => new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    const opening = chat.selectChannel(channel(1));
    chat.clearChannels();
    await opening;
    expect(chat.loading).toBe(false);
    expect(chat.messages).toEqual([]);
  });
});

describe("showChannels (a server's channels arrived)", () => {
  const server = { id: 1, name: "s", icon: "" };
  const list = [channel(10, 1, "voice"), channel(11), channel(12)];

  it("opens the first text channel", async () => {
    mockApi({ "GET /channels/11/messages": () => json([]) });
    await chat.showChannels(server, list);
    expect(chat.channels).toEqual(list);
    expect(chat.activeChannel?.id).toBe(11);
  });

  it("prefers the one you read last in this server", async () => {
    localStorage.setItem("gc_channels", JSON.stringify({ 1: 12 }));
    mockApi({ "GET /channels/12/messages": () => json([]) });
    await chat.showChannels(server, list);
    expect(chat.activeChannel?.id).toBe(12);
  });

  it("falls back when the remembered channel is gone, or was a voice channel", async () => {
    localStorage.setItem("gc_channels", JSON.stringify({ 1: 10 }));
    mockApi({ "GET /channels/11/messages": () => json([]) });
    await chat.showChannels(server, list);
    expect(chat.activeChannel?.id).toBe(11);
  });

  it("stays where you are, picking up a rename, without reloading", async () => {
    const api = mockApi({ "GET /channels/12/messages": () => json([message(1, 12)]) });
    await chat.selectChannel(channel(12));
    api.calls.length = 0;
    await chat.showChannels(server, [channel(11), { ...channel(12), name: "renamed" }]);
    expect(chat.activeChannel?.name).toBe("renamed");
    expect(chat.messages).toHaveLength(1);
    expect(api.calls).toHaveLength(0);
  });

  it("clears the chat when there's no text channel", async () => {
    mockApi({ "GET /channels/11/messages": () => json([message(1, 11)]) });
    await chat.showChannels(server, list);
    await chat.showChannels(server, [channel(10, 1, "voice")]);
    expect(chat.activeChannel).toBeNull();
    expect(chat.messages).toEqual([]);
  });
});

describe("live messages", () => {
  beforeEach(async () => {
    mockApi({ "GET /channels/1/messages": () => json([message(1, 1)]) });
    await chat.selectChannel(channel(1));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("appends messages for the open channel, and only those", () => {
    chat.receive(message(2, 1));
    chat.receive(message(3, 99));
    expect(chat.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("applies edits and deletes", () => {
    chat.receive(message(2, 1));
    chat.edited(2, "changed", "2026-01-01 00:01:00");
    expect(chat.messages.find((m) => m.id === 2)).toMatchObject({ content: "changed", edited_at: "2026-01-01 00:01:00" });
    expect(chat.messages.find((m) => m.id === 1)?.content).toBe("m1");
    chat.deleted(2);
    expect(chat.messages.map((m) => m.id)).toEqual([1]);
  });

  it("who may change what", () => {
    const mine = message(5, 1, 1), theirs = message(6, 1, 2);
    expect(chat.canEdit(mine)).toBe(true);
    expect(chat.canEdit(theirs)).toBe(false);
    expect(chat.canDelete(mine)).toBe(true);
    expect(chat.canDelete(theirs)).toBe(false);
    session.me = admin;
    expect(chat.canEdit(theirs)).toBe(false); // admins can only delete
    expect(chat.canDelete(theirs)).toBe(true);
    session.me = null;
    expect(chat.canEdit(mine)).toBe(false);
    expect(chat.canDelete(mine)).toBe(false);
  });

  describe("the new-message ping", () => {
    it("pings for someone else's message in a channel you're not reading", () => {
      chat.receive(message(2, 99));
      expect(playSound).toHaveBeenCalledWith("ping");
    });

    it("pings in the open channel too if the window isn't focused", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      chat.receive(message(2, 1));
      expect(playSound).toHaveBeenCalledOnce();
    });

    it("stays quiet when you're reading it", () => {
      chat.receive(message(2, 1));
      expect(playSound).not.toHaveBeenCalled();
    });

    it("pings if the open channel is hidden behind the call view", () => {
      ui.mainView = "call";
      chat.receive(message(2, 1));
      expect(playSound).toHaveBeenCalledOnce();
    });

    it("stays quiet for your own messages", () => {
      chat.receive(message(2, 99, me.id));
      expect(playSound).not.toHaveBeenCalled();
    });

    it("pings once for a burst", () => {
      chat.receive(message(2, 99));
      chat.receive(message(3, 99));
      vi.advanceTimersByTime(999);
      chat.receive(message(4, 99));
      expect(playSound).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      chat.receive(message(5, 99));
      expect(playSound).toHaveBeenCalledTimes(2);
    });

    it("stays quiet in muted channels", async () => {
      mockApi({ "GET /channel-mutes": () => json([99]) });
      await chat.loadMuted();
      chat.receive(message(2, 99));
      expect(playSound).not.toHaveBeenCalled();
    });
  });
});

describe("muting channels", () => {
  it("shows at once and tells the server", async () => {
    const api = mockApi({ "PUT /channel-mutes/4": () => new Response(null, { status: 204 }), "DELETE /channel-mutes/4": () => new Response(null, { status: 204 }) });
    chat.toggleMute(4);
    expect(chat.mutedChannels.has(4)).toBe(true);
    await vi.waitFor(() => expect(api.paths()).toEqual(["PUT /channel-mutes/4"]));
    chat.toggleMute(4);
    expect(chat.mutedChannels.has(4)).toBe(false);
    await vi.waitFor(() => expect(api.paths()).toEqual(["PUT /channel-mutes/4", "DELETE /channel-mutes/4"]));
  });

  it("goes back when the server says no", async () => {
    mockApi({ "PUT /channel-mutes/4": () => new Response("no", { status: 500 }) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chat.toggleMute(4);
    expect(chat.mutedChannels.has(4)).toBe(true);
    await vi.waitFor(() => expect(chat.mutedChannels.has(4)).toBe(false));
  });

  it("goes back when the server can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chat.toggleMute(4);
    await vi.waitFor(() => expect(chat.mutedChannels.has(4)).toBe(false));
  });

  it("keeps the old set intact (it's replaced, not changed)", () => {
    mockApi({ "PUT /channel-mutes/4": () => new Response(null, { status: 204 }) });
    const before = chat.mutedChannels;
    chat.toggleMute(4);
    expect(chat.mutedChannels).not.toBe(before);
    expect(before.has(4)).toBe(false);
  });

  it("loadMuted keeps what it had when the server fails", async () => {
    mockApi({ "GET /channel-mutes": () => new Response("x", { status: 500 }) });
    await chat.loadMuted();
    expect(chat.mutedChannels.size).toBe(0);
  });
});

describe("sending", () => {
  beforeEach(async () => {
    mockApi({ "GET /channels/1/messages": () => json([]) });
    await chat.selectChannel(channel(1));
  });

  it("sends the draft to the open channel and clears it", () => {
    chat.draft = "  hello  ";
    chat.sendMessage();
    expect(send).toHaveBeenCalledWith({ channel_id: 1, content: "hello", attachment_url: "", attachment_type: "" });
    expect(chat.draft).toBe("");
  });

  it("sends an attachment with it, or alone", () => {
    chat.pendingAttachment = { url: "/files/a.png", type: "image", name: "a.png" };
    chat.draft = "look";
    chat.sendMessage();
    expect(send).toHaveBeenLastCalledWith({ channel_id: 1, content: "look", attachment_url: "/files/a.png", attachment_type: "image" });
    expect(chat.pendingAttachment).toBeNull();

    chat.pendingAttachment = { url: "/files/b.png", type: "image", name: "b.png" };
    chat.sendMessage();
    expect(send).toHaveBeenLastCalledWith({ channel_id: 1, content: "", attachment_url: "/files/b.png", attachment_type: "image" });
  });

  it("sends nothing for nothing", () => {
    chat.draft = "   ";
    chat.sendMessage();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the draft when the connection is down, so it isn't lost", () => {
    send.mockReturnValue(false);
    chat.draft = "important";
    chat.pendingAttachment = { url: "/files/a.png", type: "image", name: "a.png" };
    chat.sendMessage();
    expect(chat.draft).toBe("important");
    expect(chat.pendingAttachment).not.toBeNull();
  });

  it("sends nothing with no channel open", () => {
    chat.clearChannels();
    chat.draft = "hi";
    chat.sendMessage();
    expect(send).not.toHaveBeenCalled();
    expect(chat.draft).toBe("hi");
  });

  it("sends a sticker on its own, leaving the draft", () => {
    chat.draft = "typing...";
    chat.sendSticker({ id: 1, name: "wave", url: "/files/sticker-ab.png", created_by: 1 });
    expect(send).toHaveBeenCalledWith({ channel_id: 1, content: "", attachment_url: "/files/sticker-ab.png", attachment_type: "sticker" });
    expect(chat.draft).toBe("typing...");
  });
});

describe("uploading", () => {
  it("holds the file until you send it", async () => {
    mockApi({ "POST /upload": () => json({ url: "/files/a.png", type: "image", name: "a.png" }) });
    const done = chat.uploadFile(new File(["x"], "a.png"));
    expect(chat.uploading).toBe(true);
    await done;
    expect(chat.uploading).toBe(false);
    expect(chat.pendingAttachment).toEqual({ url: "/files/a.png", type: "image", name: "a.png" });
    expect(chat.uploadError).toBe("");
  });

  it.each([
    [413, "File too large (max 25 MB)."],
    [429, "Too many uploads at once. Try again in a moment."],
    [500, "Upload failed."],
  ])("explains a %i", async (status, text) => {
    mockApi({ "POST /upload": () => new Response("", { status }) });
    await chat.uploadFile(new File(["x"], "a.png"));
    expect(chat.uploadError).toBe(text);
    expect(chat.pendingAttachment).toBeNull();
    expect(chat.uploading).toBe(false);
  });

  it("explains a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await chat.uploadFile(new File(["x"], "a.png"));
    expect(chat.uploadError).toBe("Upload failed.");
    expect(chat.uploading).toBe(false);
  });
});

describe("channels", () => {
  it("adds a channel you created without waiting for the broadcast, once", async () => {
    mockApi({ "POST /servers/1/channels": () => json(channel(20)) });
    await chat.createChannel(1, "new", "text");
    await chat.createChannel(1, "new", "text"); // the broadcast might have got there first
    expect(chat.channels.filter((c) => c.id === 20)).toHaveLength(1);
  });

  it("adds nothing when refused", async () => {
    mockApi({ "POST /servers/1/channels": () => new Response("no", { status: 403 }) });
    await chat.createChannel(1, "new", "text");
    expect(chat.channels).toEqual([]);
  });

  it("renames and deletes through the server", async () => {
    const api = mockApi({ "PATCH /channels/3": () => new Response(null, { status: 204 }), "DELETE /channels/3": () => new Response("admins only", { status: 403 }) });
    expect(await chat.renameChannel(3, "x")).toBe("");
    expect(await chat.deleteChannel(3)).toBe("admins only");
    expect(api.calls[0].body).toEqual({ name: "x" });
  });

  it("reset forgets everything about the signed-in user", async () => {
    mockApi({ "GET /channels/1/messages": () => json([message(1, 1)]), "PUT /channel-mutes/4": () => new Response(null, { status: 204 }) });
    await chat.selectChannel(channel(1));
    chat.toggleMute(4);
    chat.reset();
    expect(chat.channels).toEqual([]);
    expect(chat.activeChannel).toBeNull();
    expect(chat.messages).toEqual([]);
    expect(chat.mutedChannels.size).toBe(0);
  });
});
