import { beforeEach, describe, expect, it, vi } from "vitest";
import { admin, json, me, mockApi } from "./test-utils.ts";
import { session, SIGNED_OUT_KEY } from "./session.svelte.ts";

beforeEach(() => {
  session.me = null;
  session.signedOut = false;
  session.onExpired = async () => {};
});

describe("api", () => {
  it("prefixes /api and passes the request on", async () => {
    const api = mockApi({ "PATCH /x": () => json({}) });
    await session.api("/x", { method: "PATCH", body: "{}" });
    expect(api.paths()).toEqual(["PATCH /x"]);
  });

  it("treats a 401 while signed in as the session ending", async () => {
    mockApi({ "GET /x": () => new Response("", { status: 401 }) });
    session.me = me;
    localStorage.setItem(SIGNED_OUT_KEY, "1");
    const expired = vi.fn(async () => {});
    session.onExpired = expired;
    const res = await session.api("/x");
    expect(res.status).toBe(401);
    await vi.waitFor(() => expect(session.signedOut).toBe(true));
    expect(expired).toHaveBeenCalledOnce();
  });

  it("doesn't, when nobody was signed in (a failed login check isn't a session ending)", async () => {
    mockApi({ "GET /x": () => new Response("", { status: 401 }) });
    const expired = vi.fn(async () => {});
    session.onExpired = expired;
    await session.api("/x");
    expect(expired).not.toHaveBeenCalled();
  });
});

describe("needSignIn", () => {
  it("goes straight to the identity provider in a browser", () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...location, replace });
    session.needSignIn();
    expect(replace).toHaveBeenCalledWith("/api/auth/login");
    expect(session.signedOut).toBe(false);
  });

  it("shows the sign-in screen after you signed out on purpose", () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...location, replace });
    localStorage.setItem(SIGNED_OUT_KEY, "1");
    session.needSignIn();
    expect(replace).not.toHaveBeenCalled();
    expect(session.signedOut).toBe(true);
  });
});

describe("signIn", () => {
  it("forgets having signed out, and heads to the login", () => {
    const loc = { href: "" };
    vi.stubGlobal("location", loc);
    localStorage.setItem(SIGNED_OUT_KEY, "1");
    session.signIn();
    expect(localStorage.getItem(SIGNED_OUT_KEY)).toBeNull();
    expect(loc.href).toBe("/api/auth/login");
  });
});

describe("who you are", () => {
  it("isMe compares identities as strings", () => {
    session.me = { ...me, id: 42 };
    expect(session.isMe("42")).toBe(true);
    expect(session.isMe("7")).toBe(false);
    session.me = null;
    expect(session.isMe("42")).toBe(false);
  });

  it("canRemove: whoever added it, or an admin", () => {
    const item = { id: 1, name: "x", url: "/files/x", created_by: 5 };
    session.me = { ...me, id: 5 };
    expect(session.canRemove(item)).toBe(true);
    session.me = { ...me, id: 6 };
    expect(session.canRemove(item)).toBe(false);
    session.me = { ...admin, id: 6 };
    expect(session.canRemove(item)).toBe(true);
    session.me = null;
    expect(session.canRemove(item)).toBe(false);
  });
});

describe("submit", () => {
  it("is empty on success, and sends JSON bodies", async () => {
    const api = mockApi({ "PATCH /servers/1": () => new Response(null, { status: 204 }) });
    expect(await session.submit("/servers/1", "PATCH", { name: "n" })).toBe("");
    expect(api.calls[0].body).toEqual({ name: "n" });
  });

  it("is the server's reason on failure", async () => {
    mockApi({ "DELETE /x": () => new Response("admins only", { status: 403 }) });
    expect(await session.submit("/x", "DELETE")).toBe("admins only");
  });

  it("says so when the server can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(await session.submit("/x", "PUT")).toBe("Can't reach the server.");
  });

  it("sends forms as they are, without a JSON content type", async () => {
    const api = mockApi({ "POST /up": () => new Response(null, { status: 204 }) });
    const form = new FormData();
    form.append("a", "b");
    await session.submit("/up", "POST", form);
    expect(api.calls[0].body).toBe(form);
    const init = api.fetch.mock.calls[0][1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });
});

describe("your profile", () => {
  it("takes the profile the server answers with", async () => {
    mockApi({ "PATCH /me": () => json({ ...me, name: "New Name" }) });
    session.me = me;
    expect(await session.updateName("New Name")).toBe("");
    expect(session.me?.name).toBe("New Name");
  });

  it("keeps your profile and says why when the change is refused", async () => {
    mockApi({ "PATCH /me": () => new Response("names can be up to 32 characters", { status: 400 }) });
    session.me = me;
    expect(await session.updateName("x".repeat(40))).toBe("names can be up to 32 characters");
    expect(session.me).toEqual(me);
  });

  it("uploads and removes a picture", async () => {
    const api = mockApi({
      "PUT /me/avatar": () => json({ ...me, avatar: "/files/avatar-1.png" }),
      "DELETE /me/avatar": () => json(me),
    });
    session.me = me;
    expect(await session.setAvatar(new File(["x"], "me.png"))).toBe("");
    expect(session.me?.avatar).toBe("/files/avatar-1.png");
    expect(await session.resetAvatar()).toBe("");
    expect(session.me?.avatar).toBe("");
    expect(api.paths()).toEqual(["PUT /me/avatar", "DELETE /me/avatar"]);
  });
});
