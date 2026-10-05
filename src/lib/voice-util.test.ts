import { describe, expect, it } from "vitest";
import type { ScreenStream, VoiceMember, VoiceParticipant } from "./types.ts";
import {
  hideSelfIfJustLeft, JUST_LEFT_MS, ownPicture, parseRooms, personButtonLabel, personStatus, sameParticipants, sameStreams,
} from "./voice-util.ts";

const person = (identity: string, over: Partial<VoiceParticipant> = {}): VoiceParticipant =>
  ({ identity, name: identity, avatar: "", muted: false, deafened: false, ...over });
const member = (identity: string, over: Partial<VoiceMember> = {}): VoiceMember => ({ ...person(identity), streaming: false, ...over });

describe("ownPicture", () => {
  it("only trusts pictures from our own file store", () => {
    expect(ownPicture("/files/avatar-1.png")).toBe("/files/avatar-1.png");
    expect(ownPicture("https://evil.example/x.png")).toBe("");
    expect(ownPicture("//evil.example/files/x.png")).toBe("");
    expect(ownPicture("javascript:alert(1)")).toBe("");
    expect(ownPicture("")).toBe("");
    expect(ownPicture(undefined)).toBe("");
  });
});

describe("sameParticipants", () => {
  it("compares everything that's shown", () => {
    const a = [person("1"), person("2")];
    expect(sameParticipants(a, [person("1"), person("2")])).toBe(true);
    expect(sameParticipants(a, [person("1")])).toBe(false);
    expect(sameParticipants(a, [person("1"), person("2", { muted: true })])).toBe(false);
    expect(sameParticipants(a, [person("1"), person("2", { deafened: true })])).toBe(false);
    expect(sameParticipants(a, [person("1"), person("2", { name: "x" })])).toBe(false);
    expect(sameParticipants(a, [person("1"), person("2", { avatar: "/files/a.png" })])).toBe(false);
    expect(sameParticipants(a, [person("2"), person("1")])).toBe(false);
  });
});

describe("sameStreams", () => {
  const stream = (identity: string, over: Partial<ScreenStream> = {}): ScreenStream =>
    ({ identity, name: identity, local: false, track: null, loading: false, ...over });

  it("is true only when nothing a tile shows has changed", () => {
    const track = {} as ScreenStream["track"];
    expect(sameStreams([stream("1", { track })], [stream("1", { track })])).toBe(true);
    expect(sameStreams([stream("1", { track })], [stream("1", { track: {} as ScreenStream["track"] })])).toBe(false);
    expect(sameStreams([stream("1")], [stream("1", { loading: true })])).toBe(false);
    expect(sameStreams([stream("1")], [])).toBe(false);
  });
});

describe("parseRooms", () => {
  it("keys rooms by channel number and drops pictures that aren't ours", () => {
    const rooms = parseRooms({ "7": [member("1", { avatar: "/files/a.png" }), member("2", { avatar: "https://x/y.png" })], "8": [] });
    expect([...rooms.keys()]).toEqual([7, 8]);
    expect(rooms.get(7)!.map((m) => m.avatar)).toEqual(["/files/a.png", ""]);
  });
});

describe("hideSelfIfJustLeft", () => {
  const rooms = new Map([[5, [member("me"), member("you")]], [6, [member("me")]]]);
  const now = 1_000_000;
  const left = { channelId: 5, until: now + JUST_LEFT_MS };

  it("changes nothing when you haven't just left", () => {
    expect(hideSelfIfJustLeft(rooms, null, "me", true, now)).toEqual({ rooms, left: null });
  });

  it("hides you from the channel you left while the server still lists you there", () => {
    const out = hideSelfIfJustLeft(rooms, left, "me", true, now + 1000);
    expect(out.rooms.get(5)!.map((m) => m.identity)).toEqual(["you"]);
    expect(out.rooms.get(6)!.map((m) => m.identity)).toEqual(["me"]); // other channels untouched
    expect(out.left).toBe(left);
    expect(rooms.get(5)).toHaveLength(2); // the input isn't changed
  });

  it("stops once the server's list no longer has you there", () => {
    const gone = new Map([[5, [member("you")]]]);
    expect(hideSelfIfJustLeft(gone, left, "me", true, now + 1000)).toEqual({ rooms: gone, left: null });
  });

  it("but a local update says nothing about the server, so keeps waiting", () => {
    const gone = new Map([[5, [member("you")]]]);
    expect(hideSelfIfJustLeft(gone, left, "me", false, now + 1000)).toEqual({ rooms: gone, left });
  });

  it("gives up after the grace period even if you're still listed", () => {
    const out = hideSelfIfJustLeft(rooms, left, "me", true, now + JUST_LEFT_MS + 1);
    expect(out).toEqual({ rooms, left: null });
  });
});

describe("what a screen reader hears about someone", () => {
  it("says nothing extra about someone who's fine", () => {
    expect(personStatus({ muted: false, deafened: false }, false)).toEqual([]);
  });

  it("says who is muted, deafened, or muted by you (which wins over muted)", () => {
    expect(personStatus({ muted: true, deafened: false }, false)).toEqual(["muted"]);
    expect(personStatus({ muted: true, deafened: true }, false)).toEqual(["muted", "deafened"]);
    expect(personStatus({ muted: true, deafened: false }, true)).toEqual(["muted for you"]);
    expect(personStatus({ muted: false, deafened: true }, true)).toEqual(["muted for you", "deafened"]);
  });

  it("puts it in the button's name", () => {
    expect(personButtonLabel("alice", [])).toBe("Voice settings for alice");
    expect(personButtonLabel("alice", ["muted", "deafened"])).toBe("Voice settings for alice, muted, deafened");
  });
});
