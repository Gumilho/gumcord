import { beforeEach, describe, expect, it, vi } from "vitest";
import { channel, json, me, message, mockApi, server } from "./test-utils.ts";

vi.mock("./sounds.ts", () => ({ playSound: vi.fn(), playClip: vi.fn(), preloadSounds: vi.fn() }));
vi.mock("./socket.svelte.ts", () => ({ socket: { send: vi.fn(() => true), connect: vi.fn(), close: vi.fn() } }));

import { chat } from "./chat.svelte.ts";
import { servers } from "./servers.svelte.ts";
import { session } from "./session.svelte.ts";
import { ui } from "./ui.svelte.ts";

// What the backend answers for a server's pages.
function serverPages(id: number, over: Record<string, unknown> = {}) {
  return {
    [`GET /servers/${id}/channels`]: () => json(over.channels ?? [channel(id * 10, id), channel(id * 10 + 1, id, "voice")]),
    [`GET /servers/${id}/members`]: () => json(over.members ?? [me]),
    [`GET /servers/${id}/emotes`]: () => json(over.emotes ?? []),
    [`GET /servers/${id}/stickers`]: () => json(over.stickers ?? []),
    [`GET /channels/${id * 10}/messages`]: () => json([message(1, id * 10)]),
  };
}

beforeEach(() => {
  servers.reset();
  chat.reset();
  session.me = me;
  ui.mainView = "call";
});

describe("choosing a server", () => {
  it("opens the one you used last, if you still have it, or the first", () => {
    servers.list = [server(1), server(2), server(3)];
    expect(servers.initial()?.id).toBe(1);
    localStorage.setItem("gc_server", "3");
    expect(servers.initial()?.id).toBe(3);
    localStorage.setItem("gc_server", "99");
    expect(servers.initial()?.id).toBe(1);
    servers.list = [];
    expect(servers.initial()).toBeUndefined();
  });

  it("loads its channels, members, emotes and stickers, and opens its first text channel", async () => {
    mockApi(serverPages(1, {
      members: [me, { id: 2, name: "you", avatar: "", admin: false }],
      emotes: [{ id: 1, name: "Kappa", url: "/files/emote-k.png", created_by: 1 }],
      stickers: [{ id: 2, name: "wave", url: "/files/sticker-w.png", created_by: 1 }],
    }));
    await servers.select(server(1));
    expect(servers.active?.id).toBe(1);
    expect(servers.members).toHaveLength(2);
    expect(servers.emotes.map((e) => e.name)).toEqual(["Kappa"]);
    expect(servers.stickers.map((e) => e.name)).toEqual(["wave"]);
    expect(chat.channels.map((c) => c.id)).toEqual([10, 11]);
    expect(chat.activeChannel?.id).toBe(10);
    expect(chat.messages).toHaveLength(1);
    expect(ui.mainView).toBe("chat");
    expect(localStorage.getItem("gc_server")).toBe("1");
  });

  it("looks emotes up by lowercase name", async () => {
    mockApi(serverPages(1, { emotes: [{ id: 1, name: "Kappa", url: "/files/emote-k.png", created_by: 1 }] }));
    await servers.select(server(1));
    expect(servers.emoteMap.get("kappa")?.url).toBe("/files/emote-k.png");
    expect(servers.emoteMap.get("Kappa")).toBeUndefined();
  });

  it("shows empty lists for pages the server refuses", async () => {
    mockApi({
      ...serverPages(1),
      "GET /servers/1/members": () => new Response("no", { status: 500 }),
      "GET /servers/1/emotes": () => new Response("no", { status: 500 }),
    });
    await servers.select(server(1));
    expect(servers.members).toEqual([]);
    expect(servers.emotes).toEqual([]);
    expect(chat.channels).toHaveLength(2);
  });

  it("ignores a slow answer for a server you've already left", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const pagesOne = serverPages(1, { members: [{ id: 7, name: "from server 1", avatar: "", admin: false }] });
    mockApi({
      ...pagesOne,
      "GET /servers/1/members": async () => { await gate; return json([{ id: 7, name: "from server 1", avatar: "", admin: false }]); },
      ...serverPages(2, { members: [{ id: 8, name: "from server 2", avatar: "", admin: false }] }),
    });
    const first = servers.select(server(1));
    await servers.select(server(2));
    releaseFirst();
    await first;
    expect(servers.active?.id).toBe(2);
    expect(servers.members.map((m) => m.name)).toEqual(["from server 2"]);
    expect(chat.channels.every((c) => c.server_id === 2)).toBe(true);
  });
});

describe("refresh (an admin changed servers, channels or members)", () => {
  it("says so, and changes nothing, when the server can't be asked", async () => {
    mockApi({ "GET /servers": () => new Response("no", { status: 500 }) });
    servers.list = [server(1)];
    expect(await servers.refresh()).toBe(false);
    expect(servers.list).toHaveLength(1);
  });

  it("keeps the open server, picking up its new name", async () => {
    mockApi({ ...serverPages(1), "GET /servers": () => json([server(1, "renamed"), server(2)]) });
    await servers.select(server(1, "old"));
    expect(await servers.refresh()).toBe(true);
    expect(servers.list.map((s) => s.name)).toEqual(["renamed", "server 2"]);
    expect(servers.active?.name).toBe("renamed");
  });

  it("moves to your first server when the open one is gone", async () => {
    mockApi({ ...serverPages(1), ...serverPages(2), "GET /servers": () => json([server(2)]) });
    await servers.select(server(1));
    await servers.refresh();
    expect(servers.active?.id).toBe(2);
    expect(chat.activeChannel?.server_id).toBe(2);
  });

  it("empties everything when you have no servers left", async () => {
    mockApi({ ...serverPages(1), "GET /servers": () => json([]) });
    await servers.select(server(1, "gone"));
    await servers.refresh();
    expect(servers.list).toEqual([]);
    expect(servers.active).toBeNull();
    expect(servers.members).toEqual([]);
    expect(servers.emotes).toEqual([]);
    expect(chat.channels).toEqual([]);
    expect(chat.activeChannel).toBeNull();
    expect(chat.messages).toEqual([]);
  });

  it("starts from the first server when you had none open", async () => {
    mockApi({ ...serverPages(3), "GET /servers": () => json([server(3)]) });
    await servers.refresh();
    expect(servers.active?.id).toBe(3);
  });
});

describe("emotes and stickers", () => {
  it("refetches a list when told it changed, if you're still on that server", async () => {
    let emotes = [{ id: 1, name: "a", url: "/files/emote-a.png", created_by: 1 }];
    mockApi({ ...serverPages(1), "GET /servers/1/emotes": () => json(emotes) });
    await servers.select(server(1));
    emotes = [...emotes, { id: 2, name: "b", url: "/files/emote-b.png", created_by: 1 }];
    await servers.loadItems("emotes");
    expect(servers.emotes.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("does nothing with no server open", async () => {
    const api = mockApi({});
    await servers.loadItems("stickers");
    expect(api.calls).toHaveLength(0);
  });

  it("sends and removes to the open server, and says so when there isn't one", async () => {
    const api = mockApi({ ...serverPages(1), "POST /servers/1/emotes": () => new Response(null, { status: 204 }), "DELETE /servers/1/stickers/9": () => new Response(null, { status: 204 }) });
    expect(await servers.addItem("emotes", "x", new File(["x"], "x.png"))).toBe("No server open.");
    await servers.select(server(1));
    expect(await servers.addItem("emotes", "x", new File(["x"], "x.png"))).toBe("");
    const form = api.calls.find((c) => c.method === "POST")!.body as FormData;
    expect(form.get("name")).toBe("x");
    expect(await servers.removeItem("stickers", { id: 9, name: "s", url: "/files/s", created_by: 1 })).toBe("");
  });
});

describe("admin actions", () => {
  it("creating a server opens it", async () => {
    mockApi({ "POST /servers": () => json(server(5, "new")), ...serverPages(5) });
    expect(await servers.create("new")).toBe("");
    expect(servers.list.map((s) => s.id)).toEqual([5]);
    expect(servers.active?.id).toBe(5);
  });

  it("creating doesn't list a server twice if the broadcast got there first", async () => {
    mockApi({ "POST /servers": () => json(server(5, "new")), ...serverPages(5) });
    servers.list = [server(5, "new")];
    await servers.create("new");
    expect(servers.list).toHaveLength(1);
  });

  it("reports why a server couldn't be created", async () => {
    mockApi({ "POST /servers": () => new Response("admins only", { status: 403 }) });
    expect(await servers.create("x")).toBe("admins only");
    expect(servers.list).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await servers.create("x")).toBe("Can't reach the server.");
  });

  it("renames, deletes, and manages icons and members through the server", async () => {
    const ok = () => new Response(null, { status: 204 });
    const api = mockApi({
      "PATCH /servers/1": ok, "DELETE /servers/1": ok, "PUT /servers/1/icon": ok, "DELETE /servers/1/icon": ok,
      "PUT /servers/1/members/2": ok, "DELETE /servers/1/members/2": ok,
    });
    await servers.rename(1, "n");
    await servers.delete(1);
    await servers.setIcon(1, new File(["x"], "i.png"));
    await servers.removeIcon(1);
    await servers.addMember(1, 2);
    await servers.removeMember(1, 2);
    expect(api.paths()).toEqual(["PATCH /servers/1", "DELETE /servers/1", "PUT /servers/1/icon", "DELETE /servers/1/icon", "PUT /servers/1/members/2", "DELETE /servers/1/members/2"]);
  });

  it("lists everyone who has signed in, or nobody if that fails", async () => {
    mockApi({ "GET /users": () => json([me]) });
    expect(await servers.allUsers()).toEqual([me]);
    mockApi({ "GET /users": () => new Response("no", { status: 403 }) });
    expect(await servers.allUsers()).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await servers.allUsers()).toEqual([]);
  });
});

it("reset forgets the signed-in user's servers", async () => {
  mockApi(serverPages(1));
  servers.list = [server(1)];
  servers.online = [me];
  await servers.select(server(1));
  servers.reset();
  expect(servers.list).toEqual([]);
  expect(servers.active).toBeNull();
  expect(servers.online).toEqual([]);
  expect(servers.members).toEqual([]);
});
