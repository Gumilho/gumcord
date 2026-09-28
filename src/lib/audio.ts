// One AudioContext shared by UI sounds and speaking detection. Created without a user gesture
// (e.g. auto-rejoin after a refresh) it starts suspended until resumeAudio() runs from one.

let ctx: AudioContext | null = null;

export function audioContext() {
  return (ctx ??= new AudioContext());
}

export function audioRunning() {
  return ctx?.state === "running";
}

export async function resumeAudio() {
  await ctx?.resume();
}
