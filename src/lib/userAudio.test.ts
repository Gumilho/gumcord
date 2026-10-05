import { Track } from "livekit-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { json, me, mockApi } from "./test-utils.ts";
import { session } from "./session.svelte.ts";
import { userAudio } from "./userAudio.svelte.ts";

beforeEach(() => {
  userAudio.reset();
  userAudio.onChange = () => {};
  session.me = me;
  vi.useFakeTimers();
});

const mic = Track.Source.Microphone;
const share = Track.Source.ScreenShareAudio;

describe("what you hear", () => {
  it("is full volume for someone you haven't touched", () => {
    expect(userAudio.get("2")).toEqual({ volume: 1, muted: false, streamVolume: 1, streamMuted: false });
    expect(userAudio.volumeFor("2", mic, false)).toBe(1);
    expect(userAudio.volumeFor("2", share, false)).toBe(1);
  });

  it("follows each person's volume and mute, for voice and for their screen share separately", () => {
    userAudio.setVolume("2", 1.5);
    userAudio.setVolume("2", 0.25, "stream");
    expect(userAudio.volumeFor("2", mic, false)).toBe(1.5);
    expect(userAudio.volumeFor("2", share, false)).toBe(0.25);

    userAudio.toggleMute("2");
    expect(userAudio.volumeFor("2", mic, false)).toBe(0);
    expect(userAudio.volumeFor("2", share, false)).toBe(0.25);
    userAudio.toggleMute("2", "stream");
    expect(userAudio.volumeFor("2", share, false)).toBe(0);
    userAudio.toggleMute("2");
    expect(userAudio.volumeFor("2", mic, false)).toBe(1.5); // volume kept through a mute
  });

  it("is silent for everyone while you're deafened", () => {
    userAudio.setVolume("2", 2);
    expect(userAudio.volumeFor("2", mic, true)).toBe(0);
    expect(userAudio.volumeFor("3", share, true)).toBe(0);
  });

  it("is full volume for kinds of track it has no setting for", () => {
    expect(userAudio.volumeFor("2", Track.Source.Camera, false)).toBe(1);
  });

  it("tells the call at once, one person at a time", () => {
    const changed = vi.fn();
    userAudio.onChange = changed;
    userAudio.setVolume("2", 0.5);
    userAudio.toggleMute("3");
    expect(changed.mock.calls).toEqual([["2"], ["3"]]);
  });

  it("replaces its map on change, never changing the old one", () => {
    const before = userAudio.settings;
    userAudio.setVolume("2", 0.5);
    expect(userAudio.settings).not.toBe(before);
    expect(before.has("2")).toBe(false);
  });
});

describe("saving", () => {
  it("waits for a slider to settle, then saves once with everything", async () => {
    const api = mockApi({ "PUT /user-audio/2": () => new Response(null, { status: 204 }) });
    userAudio.setVolume("2", 0.3);
    userAudio.setVolume("2", 0.6);
    userAudio.setVolume("2", 0.9);
    await vi.advanceTimersByTimeAsync(399);
    expect(api.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.calls).toEqual([{ method: "PUT", path: "/user-audio/2", body: { volume: 0.9, muted: false, stream_volume: 1, stream_muted: false } }]);
  });

  it("saves different people independently", async () => {
    const api = mockApi({ "PUT /user-audio/2": () => new Response(null, { status: 204 }), "PUT /user-audio/3": () => new Response(null, { status: 204 }) });
    userAudio.setVolume("2", 0.5);
    userAudio.toggleMute("3");
    await vi.advanceTimersByTimeAsync(400);
    expect(api.paths().sort()).toEqual(["PUT /user-audio/2", "PUT /user-audio/3"]);
  });

  it("carries on when saving fails: it's applied here either way", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    userAudio.setVolume("2", 0.5);
    await vi.advanceTimersByTimeAsync(400);
    expect(userAudio.get("2").volume).toBe(0.5);
  });
});

describe("loading", () => {
  it("reads the saved settings, and joining waits for them", async () => {
    mockApi({ "GET /user-audio": () => json([{ target_id: 7, volume: 1.4, muted: true, stream_volume: 0.2, stream_muted: false }]) });
    const loading = userAudio.load();
    expect(userAudio.loaded).toBe(loading);
    await loading;
    expect(userAudio.get("7")).toEqual({ volume: 1.4, muted: true, streamVolume: 0.2, streamMuted: false });
  });

  it("starts from the defaults if they can't be loaded, without failing", async () => {
    mockApi({ "GET /user-audio": () => new Response("no", { status: 500 }) });
    await userAudio.load();
    expect(userAudio.get("7").volume).toBe(1);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(userAudio.load()).resolves.toBeUndefined();
  });
});

describe("the menu", () => {
  const click = (x: number, y: number) => new MouseEvent("click", { clientX: x, clientY: y, cancelable: true });

  it("opens at the pointer, for someone else", () => {
    const e = click(10, 20);
    userAudio.openMenu(e, { identity: "2", name: "bob" });
    expect(userAudio.menu).toEqual({ identity: "2", name: "bob", kind: "voice", x: 10, y: 20 });
    expect(e.defaultPrevented).toBe(true);
  });

  it("is for the stream's audio when asked", () => {
    userAudio.openMenu(click(1, 1), { identity: "2", name: "bob" }, "stream");
    expect(userAudio.menu?.kind).toBe("stream");
  });

  it("has none for yourself, and swallows the click all the same", () => {
    const e = click(1, 1);
    userAudio.openMenu(e, { identity: String(me.id), name: "me" });
    expect(userAudio.menu).toBeNull();
    expect(e.defaultPrevented).toBe(true);
  });

  it("opens from the keyboard with Enter or Space, under the row, and ignores other keys", () => {
    const row = document.createElement("div");
    row.getBoundingClientRect = () => ({ left: 5, bottom: 50 }) as DOMRect;
    const press = (key: string) => {
      const e = new KeyboardEvent("keydown", { key, cancelable: true });
      Object.defineProperty(e, "currentTarget", { value: row });
      return e;
    };
    userAudio.openMenu(press("a"), { identity: "2", name: "bob" });
    expect(userAudio.menu).toBeNull();
    userAudio.openMenu(press("Enter"), { identity: "2", name: "bob" });
    expect(userAudio.menu).toMatchObject({ x: 5, y: 50 });
    userAudio.closeMenu();
    userAudio.openMenu(press(" "), { identity: "2", name: "bob" });
    expect(userAudio.menu).not.toBeNull();
  });

  it("opens a click made from the keyboard under the row, not at a pointer that isn't there", () => {
    const row = document.createElement("button");
    row.getBoundingClientRect = () => ({ left: 12, bottom: 90 }) as DOMRect;
    // A real mouse click always has a position; Enter or Space on a button sends one with none.
    const fromKeyboard = new MouseEvent("click", { clientX: 0, clientY: 0, detail: 0, cancelable: true });
    Object.defineProperty(fromKeyboard, "currentTarget", { value: row });
    userAudio.openMenu(fromKeyboard, { identity: "2", name: "bob" });
    expect(userAudio.menu).toMatchObject({ x: 12, y: 90 });

    userAudio.closeMenu();
    const atCorner = new MouseEvent("click", { clientX: 0, clientY: 0, detail: 1, cancelable: true }); // really clicked at 0,0
    Object.defineProperty(atCorner, "currentTarget", { value: row });
    userAudio.openMenu(atCorner, { identity: "2", name: "bob" });
    expect(userAudio.menu).toMatchObject({ x: 0, y: 0 });
  });

  it("closes", () => {
    userAudio.openMenu(click(1, 1), { identity: "2", name: "bob" });
    userAudio.closeMenu();
    expect(userAudio.menu).toBeNull();
  });

  it("reset forgets the settings and closes the menu", () => {
    userAudio.setVolume("2", 0.5);
    userAudio.openMenu(click(1, 1), { identity: "2", name: "bob" });
    userAudio.reset();
    expect(userAudio.get("2").volume).toBe(1);
    expect(userAudio.menu).toBeNull();
  });
});
