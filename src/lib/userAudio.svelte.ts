// How loud you hear each person in a call, and the menu to change it. Settings are saved on the
// server, so they follow you between devices. The call itself applies them (see voice.svelte.ts).
import { Track } from "livekit-client";
import { session } from "./session.svelte.ts";
import type { AudioKind, UserAudio } from "./types.ts";

const DEFAULT_USER_AUDIO: UserAudio = { volume: 1, muted: false, streamVolume: 1, streamMuted: false };
// Sliders fire continuously; save once the value settles.
const USER_AUDIO_SAVE_MS = 400;

class UserAudioStore {
  // By identity (user ID). Replaced wholesale on change.
  settings: ReadonlyMap<string, UserAudio> = $state.raw(new Map());
  // The per-person audio menu, opened by right-clicking someone in the call.
  menu: { identity: string; name: string; kind: AudioKind; x: number; y: number } | null = $state(null);
  // Joining voice waits for this, so nobody is heard at the default volume before their setting loads.
  loaded: Promise<void> = Promise.resolve();

  // Told when someone's setting changed, so the call can apply it. Set by voice.svelte.ts.
  onChange: (identity: string) => void = () => {};

  #saves = new Map<string, ReturnType<typeof setTimeout>>();

  get(identity: string): UserAudio {
    return this.settings.get(identity) ?? DEFAULT_USER_AUDIO;
  }

  // What to play someone's track at: nothing when you're deafened.
  volumeFor(identity: string, source: Track.Source, deafened: boolean) {
    if (deafened) return 0;
    const audio = this.get(identity);
    if (source === Track.Source.Microphone) return audio.muted ? 0 : audio.volume;
    if (source === Track.Source.ScreenShareAudio) return audio.streamMuted ? 0 : audio.streamVolume;
    return 1;
  }

  load() {
    this.loaded = this.#load();
    return this.loaded;
  }

  async #load() {
    try {
      const res = await session.api("/user-audio");
      if (!res.ok) return;
      const list: { target_id: number; volume: number; muted: boolean; stream_volume: number; stream_muted: boolean }[] = await res.json();
      this.settings = new Map(list.map((a) => [String(a.target_id), {
        volume: a.volume, muted: a.muted, streamVolume: a.stream_volume, streamMuted: a.stream_muted,
      }]));
    } catch (err) {
      console.warn("Couldn't load voice settings:", err);
    }
  }

  setVolume(identity: string, volume: number, kind: AudioKind = "voice") {
    const audio = this.get(identity);
    this.#set(identity, kind === "voice" ? { ...audio, volume } : { ...audio, streamVolume: volume });
  }

  toggleMute(identity: string, kind: AudioKind = "voice") {
    const audio = this.get(identity);
    this.#set(identity, kind === "voice" ? { ...audio, muted: !audio.muted } : { ...audio, streamMuted: !audio.streamMuted });
  }

  #set(identity: string, audio: UserAudio) {
    this.settings = new Map(this.settings).set(identity, audio);
    this.onChange(identity);

    clearTimeout(this.#saves.get(identity));
    this.#saves.set(identity, setTimeout(() => {
      this.#saves.delete(identity);
      session.api(`/user-audio/${identity}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          volume: audio.volume, muted: audio.muted, stream_volume: audio.streamVolume, stream_muted: audio.streamMuted,
        }),
      }).catch((err) => console.warn("Couldn't save voice settings:", err));
    }, USER_AUDIO_SAVE_MS));
  }

  // Click or right-click opens it at the pointer; Enter or Space opens it under the row, and so does
  // a click made from the keyboard (which arrives with no pointer position).
  // Your own row has no menu: there's nothing to adjust about hearing yourself.
  openMenu(e: MouseEvent | KeyboardEvent, p: { identity: string; name: string }, kind: AudioKind = "voice") {
    if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    if (session.isMe(p.identity)) return;
    const atPointer = e instanceof MouseEvent && !(e.detail === 0 && e.clientX === 0 && e.clientY === 0);
    const at = atPointer
      ? { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }
      : (() => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left, y: r.bottom }; })();
    this.menu = { identity: p.identity, name: p.name, kind, ...at };
  }

  closeMenu() {
    this.menu = null;
  }

  // Signing out.
  reset() {
    this.settings = new Map();
    this.menu = null;
  }
}

export const userAudio = new UserAudioStore();
