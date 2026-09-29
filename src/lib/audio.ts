// One AudioContext shared by UI sounds, speaking detection and call audio (LiveKit's web audio mix).
// Created without a user gesture (e.g. auto-rejoin after a refresh) it starts suspended until
// resumeAudio() runs from one.

type SinkContext = AudioContext & { setSinkId?(id: string): Promise<void> };

let ctx: SinkContext | null = null;
let outputDevice = ""; // "" is the system default

// Choosing the speakers is Chromium-only; elsewhere everything plays on the system default.
export const canPickOutput = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

export function audioContext() {
  if (!ctx) {
    ctx = new AudioContext();
    if (outputDevice) void applyOutput();
  }
  return ctx;
}

export function audioRunning() {
  return ctx?.state === "running";
}

export async function resumeAudio() {
  await ctx?.resume();
}

// Sends everything the app plays to this output device. Applied when the context exists, or once it's created.
export async function setOutputDevice(deviceId: string) {
  outputDevice = deviceId === "default" ? "" : deviceId;
  if (ctx) await applyOutput();
}

async function applyOutput() {
  if (!canPickOutput || !ctx) return;
  try {
    await ctx.setSinkId?.(outputDevice);
  } catch (err) {
    // The device went away: fall back to the default rather than playing nowhere.
    console.warn("Couldn't switch speakers:", err);
    outputDevice = "";
    await ctx.setSinkId?.("").catch(() => {});
  }
}
