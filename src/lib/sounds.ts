// UI sounds decoded once into memory. <audio> elements fetch via HTTP range requests (206)
// and re-request on every play; AudioBuffers never touch the network after the first load.

import { audioContext } from "./audio.ts";

const files = import.meta.glob<string>("/assets/*.mp3", { eager: true, query: "?url", import: "default" });

export type SoundName = "connect" | "disconnect" | "mute" | "unmute" | "deafen" | "undeafen";

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
