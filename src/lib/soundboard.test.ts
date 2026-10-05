import { beforeEach, describe, expect, it, vi } from "vitest";
import { json, me, mockApi } from "./test-utils.ts";

// The call is a stand-in: the soundboard's job is what it does with the call's events and its room.
const hooks = vi.hoisted(() => ({
  joined: [] as (() => void)[], left: [] as (() => void)[], data: new Map<string, (id: string, p: Uint8Array) => void>(),
}));
const fakeVoice = vi.hoisted(() => ({
  room: null as null | { localParticipant: { publishData: (...a: unknown[]) => Promise<void> } },
  channel: null as null | { id: number; server_id: number },
  deafened: false,
  onJoined: (fn: () => void) => hooks.joined.push(fn),
  onLeft: (fn: () => void) => hooks.left.push(fn),
  onData: (topic: string, fn: (id: string, p: Uint8Array) => void) => hooks.data.set(topic, fn),
}));
vi.mock("./voice.svelte.ts", () => ({ voice: fakeVoice }));
const playClip = vi.fn();
vi.mock("./sounds.ts", () => ({ playClip: (...a: unknown[]) => playClip(...a), playSound: vi.fn(), preloadSounds: vi.fn() }));

import { prefs } from "./prefs.svelte.ts";
import { session } from "./session.svelte.ts";
import { SOUND_URL, soundboard } from "./soundboard.svelte.ts";
import { userAudio } from "./userAudio.svelte.ts";

const good = "/files/sound-" + "ab12".repeat(6) + ".mp3";
const sound = { id: 1, name: "airhorn", url: good, created_by: 1 };
const payload = (url: unknown) => new TextEncoder().encode(JSON.stringify({ url }));
const publishData = vi.fn(async (..._a: unknown[]) => {});

beforeEach(() => {
  session.me = me;
  fakeVoice.room = { localParticipant: { publishData } };
  fakeVoice.channel = { id: 5, server_id: 3 };
  fakeVoice.deafened = false;
  userAudio.reset();
  prefs.setSoundboardVolume(0.7);
  hooks.left.forEach((fn) => fn());
  playClip.mockClear();
  publishData.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 3_600_000); // past every earlier test's cooldown
});

describe("which sounds are accepted from other people", () => {
  it.each([
    [good, true],
    ["/files/sound-" + "0".repeat(24) + ".wav", true],
    ["/files/sound-" + "0".repeat(24) + ".ogg", true],
    ["https://evil.example/sound.mp3", false],
    ["//evil.example" + good, false],
    ["/files/avatar-" + "0".repeat(24) + ".png", false],
    ["/files/sound-" + "0".repeat(23) + ".mp3", false],
    ["/files/sound-" + "g".repeat(24) + ".mp3", false],
    ["/files/sound-" + "0".repeat(24) + ".mp3/../../x", false],
    ["/files/../sound-" + "0".repeat(24) + ".mp3", false],
    ["", false],
  ])("%s → %s", (url, ok) => {
    expect(SOUND_URL.test(url)).toBe(ok);
  });
});

describe("hearing what others play", () => {
  const receive = (id: string, p: Uint8Array) => hooks.data.get("soundboard")!(id, p);

  it("plays a sound at the soundboard volume", () => {
    receive("2", payload(good));
    expect(playClip).toHaveBeenCalledWith(good, 0.7);
  });

  it("ignores anything that isn't one of the server's sounds, or isn't a message", () => {
    receive("2", payload("https://evil.example/x.mp3"));
    receive("2", payload(42));
    receive("2", payload(undefined));
    receive("2", new TextEncoder().encode("not json"));
    receive("2", new Uint8Array([0xff, 0xfe]));
    expect(playClip).not.toHaveBeenCalled();
  });

  it("limits each person to a sound every half second", () => {
    receive("2", payload(good));
    receive("2", payload(good));
    vi.advanceTimersByTime(499);
    receive("2", payload(good));
    expect(playClip).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    receive("2", payload(good));
    expect(playClip).toHaveBeenCalledTimes(2);
    receive("3", payload(good)); // someone else isn't held back by that
    expect(playClip).toHaveBeenCalledTimes(3);
  });

  it("is silent while you're deafened, or have muted that person", () => {
    fakeVoice.deafened = true;
    receive("2", payload(good));
    fakeVoice.deafened = false;
    userAudio.toggleMute("3");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    receive("3", payload(good));
    expect(playClip).not.toHaveBeenCalled();
    receive("4", payload(good));
    expect(playClip).toHaveBeenCalledTimes(1);
  });
});

describe("playing sounds", () => {
  it("sends it to the call, and plays it for you", () => {
    soundboard.play(sound);
    expect(publishData).toHaveBeenCalledOnce();
    const [data, options] = publishData.mock.calls[0] as [Uint8Array, unknown];
    expect(JSON.parse(new TextDecoder().decode(data))).toEqual({ url: good });
    expect(options).toEqual({ reliable: true, topic: "soundboard" });
    expect(playClip).toHaveBeenCalledWith(good, 0.7);
  });

  it("is one sound a second for you", () => {
    soundboard.play(sound);
    vi.advanceTimersByTime(999);
    soundboard.play(sound);
    expect(publishData).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    soundboard.play(sound);
    expect(publishData).toHaveBeenCalledTimes(2);
  });

  it("does nothing outside a call", () => {
    fakeVoice.room = null;
    soundboard.play(sound);
    expect(publishData).not.toHaveBeenCalled();
    expect(playClip).not.toHaveBeenCalled();
  });

  it("doesn't play it for you while deafened, but others still hear it", () => {
    fakeVoice.deafened = true;
    soundboard.play(sound);
    expect(publishData).toHaveBeenCalledOnce();
    expect(playClip).not.toHaveBeenCalled();
  });

  it("keeps going if the call can't take the message", async () => {
    publishData.mockRejectedValueOnce(new Error("closed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => soundboard.play(sound)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("previewing is for your ears only, with no cooldown", () => {
    soundboard.preview(sound);
    soundboard.preview(sound);
    expect(playClip).toHaveBeenCalledTimes(2);
    expect(publishData).not.toHaveBeenCalled();
  });
});

describe("the list", () => {
  it("loads the sounds of the call's server when you join, and drops them when you leave", async () => {
    const api = mockApi({ "GET /servers/3/sounds": () => json([sound]) });
    hooks.joined.forEach((fn) => fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(api.paths()).toEqual(["GET /servers/3/sounds"]);
    expect(soundboard.sounds).toEqual([sound]);
    hooks.left.forEach((fn) => fn());
    expect(soundboard.sounds).toEqual([]);
  });

  it("ignores an answer for a call you've since left", async () => {
    mockApi({ "GET /servers/3/sounds": () => json([sound]) });
    const loading = soundboard.load();
    fakeVoice.channel = null;
    await loading;
    expect(soundboard.sounds).toEqual([]);
  });

  it("does nothing outside a call", async () => {
    fakeVoice.channel = null;
    const api = mockApi({});
    await soundboard.load();
    expect(api.calls).toHaveLength(0);
  });

  it("adds and removes on the call's server, not the one on screen", async () => {
    const api = mockApi({ "POST /servers/3/sounds": () => new Response(null, { status: 204 }), "DELETE /servers/3/sounds/1": () => new Response(null, { status: 204 }) });
    expect(await soundboard.add("airhorn", new File(["x"], "a.mp3"))).toBe("");
    expect(await soundboard.remove(sound)).toBe("");
    expect(api.paths()).toEqual(["POST /servers/3/sounds", "DELETE /servers/3/sounds/1"]);
    fakeVoice.channel = null;
    expect(await soundboard.add("x", new File(["x"], "a.mp3"))).toBe("No server open.");
  });
});
