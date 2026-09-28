// UI sounds decoded once into memory. <audio> elements fetch via HTTP range requests (206)
// and re-request on every play; AudioBuffers never touch the network after the first load.

const files = import.meta.glob<string>("/assets/*.mp3", { eager: true, query: "?url", import: "default" });

export type SoundName = "connect" | "disconnect" | "mute" | "unmute" | "deafen" | "undeafen";

const VOLUME = 0.5;
// If the context is still waiting on a user gesture, drop the sound rather than play it late.
const MAX_LATE_MS = 300;

let ctx: AudioContext | null = null;
let output: GainNode | null = null;
let loading: Promise<void> | null = null;
const buffers = new Map<string, AudioBuffer>();

function context() {
  if (!ctx) {
    ctx = new AudioContext();
    output = ctx.createGain();
    output.gain.value = VOLUME;
    output.connect(ctx.destination);
  }
  return ctx;
}

export function preloadSounds() {
  loading ??= Promise.all(
    Object.entries(files).map(async ([path, url]) => {
      const name = path.slice(path.lastIndexOf("/") + 1, -".mp3".length);
      try {
        const data = await (await fetch(url)).arrayBuffer();
        buffers.set(name, await context().decodeAudioData(data));
      } catch (err) {
        console.warn(`Couldn't load sound "${name}":`, err);
      }
    }),
  ).then(() => undefined);
  return loading;
}

export function playSound(name: SoundName) {
  const buffer = buffers.get(name);
  if (!buffer) return;
  const c = context();
  const requested = performance.now();
  const start = () => {
    if (performance.now() - requested > MAX_LATE_MS) return;
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(output!);
    src.start();
  };
  if (c.state === "running") start();
  else c.resume().then(start, () => {});
}
