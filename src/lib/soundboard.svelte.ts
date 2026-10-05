// The soundboard: sounds travel through the call as data messages naming one of the server's uploads.
// It belongs to the server your call is in, which may not be the one on screen.
import { addLibraryItem, removeLibraryItem } from "./library.ts";
import { prefs } from "./prefs.svelte.ts";
import { session } from "./session.svelte.ts";
import { playClip } from "./sounds.ts";
import { userAudio } from "./userAudio.svelte.ts";
import { voice } from "./voice.svelte.ts";
import type { Sound } from "./types.ts";

const SOUNDBOARD_TOPIC  = "soundboard";
export const SOUND_URL  = /^\/files\/sound-[0-9a-f]{24}\.(?:mp3|wav|ogg)$/;
const SOUND_COOLDOWN_MS = 1_000;

class Soundboard {
  sounds: Sound[] = $state.raw([]);
  // When you, and each person in the call, last played a sound.
  #played = new Map<string, number>();

  constructor() {
    voice.onJoined(() => void this.load());
    voice.onLeft(() => {
      this.sounds = [];
      this.#played.clear();
    });
    voice.onData(SOUNDBOARD_TOPIC, (identity, payload) => this.#received(identity, payload));
  }

  async load() {
    const serverId = voice.channel?.server_id;
    if (serverId === undefined) return;
    const res = await session.api(`/servers/${serverId}/sounds`);
    if (res.ok && voice.channel?.server_id === serverId) this.sounds = await res.json();
  }

  // Plays for everyone in the call, you included. One sound a second.
  play(sound: Sound) {
    const r = voice.room;
    const me = String(session.me?.id);
    if (!r || Date.now() - (this.#played.get(me) ?? 0) < SOUND_COOLDOWN_MS) return;
    this.#played.set(me, Date.now());
    const data = new TextEncoder().encode(JSON.stringify({ url: sound.url }));
    r.localParticipant.publishData(data, { reliable: true, topic: SOUNDBOARD_TOPIC })
      .catch((err) => console.warn("Couldn't play sound for the call:", err));
    this.#hear(me, sound.url);
  }

  // Only your ears: to try a sound before playing it to everyone.
  preview(sound: Sound) {
    void playClip(sound.url, prefs.soundboardVolume);
  }

  // Each answers with an error to show, or "". The list updates from the server's broadcast.
  add(name: string, file: File) {
    return addLibraryItem(voice.channel?.server_id, "sounds", name, file);
  }

  remove(sound: Sound) {
    return removeLibraryItem(voice.channel?.server_id, "sounds", sound);
  }

  #hear(identity: string, url: string) {
    if (voice.deafened || userAudio.get(identity).muted) return;
    void playClip(url, prefs.soundboardVolume);
  }

  // Someone in the call played a sound. Only the server's own uploads, and no faster than the button allows.
  #received(identity: string, payload: Uint8Array) {
    let url: unknown;
    try {
      url = JSON.parse(new TextDecoder().decode(payload)).url;
    } catch {
      return;
    }
    if (typeof url !== "string" || !SOUND_URL.test(url)) return;
    if (Date.now() - (this.#played.get(identity) ?? 0) < SOUND_COOLDOWN_MS / 2) return;
    this.#played.set(identity, Date.now());
    this.#hear(identity, url);
  }
}

export const soundboard = new Soundboard();
