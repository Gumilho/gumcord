// The shapes of what the server sends and the app passes around, shared by the stores and the components.
import type { Track } from "livekit-client";

export type ChannelKind = "text" | "voice";
// Servers group channels. Admins see every server; everyone else, the ones they've been added to.
export interface Server { id: number; name: string; icon: string; }
export interface Channel { id: number; server_id: number; name: string; kind: ChannelKind; }
export type AttachmentType = "image" | "video" | "sticker" | "file";
export interface Message {
  id: number; channel_id: number; author_id: number; author: string; content: string; created_at: string;
  edited_at?: string; attachment_url?: string; attachment_type?: AttachmentType;
}
export interface Attachment { url: string; type: AttachmentType; name: string; }
export interface User { id: number; name: string; avatar: string; admin: boolean; }
// Something a server's members uploaded: an emote (a picture written :name: in messages), a sticker
// (a bigger picture sent on its own) or a soundboard sound. Whoever added it, or an admin, can remove it.
export interface ServerItem { id: number; name: string; url: string; created_by: number; }
export type Emote = ServerItem;
export type Sticker = ServerItem;
export type Sound = ServerItem;
export type Library = "emotes" | "stickers" | "sounds";
// identity is the stable user ID; name is the display name to show.
export interface VoiceParticipant { identity: string; name: string; avatar: string; muted: boolean; deafened: boolean; }
// Someone in a voice channel as the server reports it, for channels you aren't in yourself.
export interface VoiceMember extends VoiceParticipant { streaming: boolean; }
// How loud this user hears another in voice (1 = 100%, up to 2), or whether they've muted them.
// Local to the listener: the other person isn't affected or told.
// Their screen-share audio has its own volume and mute.
export interface UserAudio { volume: number; muted: boolean; streamVolume: number; streamMuted: boolean; }
// Which of someone's audio a setting or the menu is about.
export type AudioKind = "voice" | "stream";
// track is null until the viewer opts in to watching; loading covers the gap after they do.
export interface ScreenStream { identity: string; name: string; local: boolean; track: Track | null; loading: boolean; }
