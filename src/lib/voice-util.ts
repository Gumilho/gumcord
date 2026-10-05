// The parts of the voice call that don't need a call to run: comparing and cleaning what arrives.
import type { Participant } from "livekit-client";
import { t } from "./i18n.svelte.ts";
import type { ScreenStream, VoiceMember, VoiceParticipant } from "./types.ts";

// The server polls LiveKit every 2 s, so its list still has you briefly after you leave.
export const JUST_LEFT_MS = 5_000;

// Attributes are client-writable, so only pictures from our own store are used.
const OWN_FILE = "/files/";
export const ownPicture = (url: string | undefined) => (url?.startsWith(OWN_FILE) ? url : "");

export const avatarOf = (p: Participant) => ownPicture(p.attributes.avatar);

export const sameParticipants = (a: VoiceParticipant[], b: VoiceParticipant[]) =>
  a.length === b.length
  && a.every((p, i) => p.identity === b[i].identity && p.name === b[i].name && p.avatar === b[i].avatar
    && p.muted === b[i].muted && p.deafened === b[i].deafened);

export const sameStreams = (a: ScreenStream[], b: ScreenStream[]) =>
  a.length === b.length
  && a.every((s, i) => s.identity === b[i].identity && s.name === b[i].name && s.track === b[i].track && s.loading === b[i].loading);

// Who is in each voice channel, as the server reports it (by channel ID), with pictures that
// aren't ours dropped: they're client-set attributes the server only relays.
export function parseRooms(channels: Record<string, VoiceMember[]>): Map<number, VoiceMember[]> {
  return new Map(Object.entries(channels).map(([id, members]) => [
    Number(id),
    members.map((m) => ({ ...m, avatar: ownPicture(m.avatar) })),
  ]));
}

// The channel you just left, where you're hidden until the server's list catches up.
export interface JustLeft { channelId: number; until: number; }

// Hides you from the channel you just left until a server update no longer lists you there (or a
// few seconds pass). Says whether you're still being hidden.
export function hideSelfIfJustLeft(
  rooms: ReadonlyMap<number, VoiceMember[]>, left: JustLeft | null, meId: string, fromServer: boolean, now = Date.now(),
): { rooms: ReadonlyMap<number, VoiceMember[]>; left: JustLeft | null } {
  if (!left) return { rooms, left };
  const members = rooms.get(left.channelId) ?? [];
  const listed = members.some((m) => m.identity === meId);
  if ((fromServer && !listed) || now > left.until) return { rooms, left: null };
  return { rooms: listed ? new Map(rooms).set(left.channelId, members.filter((m) => m.identity !== meId)) : rooms, left };
}

// What the eye gets from the icons beside someone's name, in words, for screen readers. Who is
// speaking is left out: they hear that, and a label changing every moment would be read out again.
export function personStatus(p: { muted: boolean; deafened: boolean }, mutedByMe: boolean): string[] {
  const words: string[] = [];
  if (mutedByMe) words.push(t("muted for you"));
  else if (p.muted) words.push(t("muted"));
  if (p.deafened) words.push(t("deafened"));
  return words;
}

// "Voice settings for alice, muted": what the button for someone's volume menu is called.
export function personButtonLabel(name: string, status: string[]) {
  return [t("Voice settings for {name}", { name }), ...status].join(", ");
}
