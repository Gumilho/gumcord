// UI sounds decoded once into memory. <audio> elements fetch via HTTP range requests (206)
// and re-request on every play; AudioBuffers never touch the network after the first load.

import { audioContext } from "./audio.ts";

const files = import.meta.glob<string>("/assets/*.mp3", { eager: true, query: "?url", import: "default" });

export type SoundName = "connect" | "disconnect" | "mute" | "unmute" | "deafen" | "undeafen" | "ping";

const VOLUME = 0.5;
// If the context is still waiting on a user gesture, drop the sound rather than play it late.
const MAX_LATE_MS = 300;

let loading: Promise<void> | null = null;
let output: GainNode | null = null;
const buffers = new Map<string, AudioBuffer>();

// Decoding needs no realtime context, so preloading doesn't open an audio device at startup.
export function preloadSounds() {
  loading ??= (async () => {
    const decoder = new OfflineAudioContext(1, 1, 48_000);
    await Promise.all(
      Object.entries(files).map(async ([path, url]) => {
        const name = path.slice(path.lastIndexOf("/") + 1, -".mp3".length);
        try {
          buffers.set(name, await decoder.decodeAudioData(await (await fetch(url)).arrayBuffer()));
        } catch (err) {
          console.warn(`Couldn't load sound "${name}":`, err);
        }
      }),
    );
  })();
  return loading;
}

export function playSound(name: SoundName) {
  void preloadSounds().then(() => {
    const buffer = buffers.get(name);
    if (!buffer) return;
    const ctx = audioContext();
    const requested = performance.now();
    const start = () => {
      if (performance.now() - requested > MAX_LATE_MS) return;
      if (!output) {
        output = ctx.createGain();
        output.gain.value = VOLUME;
        output.connect(ctx.destination);
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(output);
      src.start();
    };
    if (ctx.state === "running") start();
    else ctx.resume().then(start, () => {});
  });
}

// ── Soundboard clips: decoded on first play, then kept ──

// However long the file, nobody holds the call hostage.
export const MAX_CLIP_SECONDS = 10;
const clips = new Map<string, Promise<AudioBuffer>>();

async function decode(data: ArrayBuffer) {
  return new OfflineAudioContext(1, 1, 48_000).decodeAudioData(data);
}

function loadClip(url: string) {
  let clip = clips.get(url);
  if (!clip) {
    clip = fetch(url).then((r) => r.arrayBuffer()).then(decode);
    clip.catch(() => clips.delete(url)); // try again next time
    clips.set(url, clip);
  }
  return clip;
}

export async function playClip(url: string, volume: number) {
  let buffer: AudioBuffer;
  try {
    buffer = await loadClip(url);
  } catch (err) {
    console.warn("Couldn't play sound:", err);
    return;
  }
  const ctx = audioContext();
  if (ctx.state !== "running") await ctx.resume().catch(() => {});
  const gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(gain);
  src.start();
  src.stop(ctx.currentTime + MAX_CLIP_SECONDS);
}

// A file's length in seconds, or null when it isn't a sound this browser can play.
export async function clipDuration(file: File) {
  try {
    return (await decode(await file.arrayBuffer())).duration;
  } catch {
    return null;
  }
}
