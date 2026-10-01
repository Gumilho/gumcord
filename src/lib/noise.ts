// Strong noise suppression for your microphone. RNNoise (a small recurrent neural network, run as
// WebAssembly in an audio worklet) takes out what the browser's own suppression leaves: keyboards,
// clicks, fans, chatter in the room. It tells voice from noise afresh every 10 ms, so it follows the
// room as it changes without any setup. It's a LiveKit track processor, so the call is sent the
// cleaned-up track.
//
// Below full strength the original microphone is mixed back in, which caps how far noise is taken
// down and softens what RNNoise can do to a voice (clipped word endings, a robotic edge).

import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import workletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import wasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import simdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

// RNNoise only works on 48 kHz audio and the shared context runs at the speakers' rate, so the
// filter has a context of its own.
const SAMPLE_RATE = 48_000;
// RNNoise's 480-sample frame plus the worklet's buffering (measured). The original is held back as
// much, so mixing the two doesn't comb-filter the voice.
const FILTER_LATENCY = 992 / SAMPLE_RATE;
// Just below full strength, noise is taken down by this much; at full strength, all the way.
const MAX_REDUCTION_DB = 40;
// Strength changes glide instead of clicking.
const MIX_GLIDE_S = 0.02;
// A context the browser won't start would send silence; better to send the unfiltered mic.
const START_TIMEOUT_MS = 1_000;

// Audio worklets need a secure page (HTTPS or localhost).
export const canSuppressNoise = typeof AudioWorkletNode !== "undefined";

// Downloaded on first use, then shared by every filter.
let wasm: Promise<ArrayBuffer> | null = null;

export class NoiseFilter implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "rnnoise";
  processedTrack?: MediaStreamTrack;
  // The microphone being filtered (LiveKit's mediaStreamTrack is the filtered one).
  input: MediaStreamTrack | null = null;

  #ctx:    AudioContext | null = null;
  #node:   RnnoiseWorkletNode | null = null;
  #delay:  DelayNode | null = null;
  #wet:    GainNode | null = null;
  #dry:    GainNode | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #strength: number;

  // strength: from 0 (the microphone as it is) to 1 (all of RNNoise).
  constructor(strength = 1) {
    this.#strength = strength;
  }

  async init({ track }: AudioProcessorOptions) {
    wasm ??= loadRnnoise({ url: wasmUrl, simdUrl: simdWasmUrl }).catch((err) => {
      wasm = null; // let a later attempt download it again
      throw err;
    });
    const ctx = (this.#ctx = new AudioContext({ sampleRate: SAMPLE_RATE }));
    try {
      const [wasmBinary] = await Promise.all([wasm, ctx.audioWorklet.addModule(workletUrl)]);
      await started(ctx);
      // Voice is sent in mono: a stereo mic is mixed down rather than cleaned up twice.
      const node = (this.#node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 }));
      node.channelCount = 1;
      node.channelCountMode = "explicit";
      const out = ctx.createMediaStreamDestination();
      out.channelCount = 1;
      this.#wet = ctx.createGain();
      this.#dry = ctx.createGain();
      this.#delay = ctx.createDelay(2 * FILTER_LATENCY);
      this.#delay.delayTime.value = FILTER_LATENCY;
      node.connect(this.#wet).connect(out);
      this.#delay.connect(this.#dry).connect(out);
      this.#mix(true);
      this.#listen(track);
      this.processedTrack = out.stream.getAudioTracks()[0];
    } catch (err) {
      await this.destroy();
      throw err;
    }
  }

  // Another microphone, or the same one reopened: the call keeps the same cleaned-up track.
  async restart({ track }: AudioProcessorOptions) {
    this.#listen(track);
  }

  setStrength(strength: number) {
    this.#strength = strength;
    this.#mix(false);
  }

  async destroy() {
    this.#source?.disconnect();
    this.#node?.destroy();
    await this.#ctx?.close().catch(() => {});
    this.#source = null;
    this.#node = null;
    this.#delay = null;
    this.#wet = null;
    this.#dry = null;
    this.#ctx = null;
    this.input = null;
    this.processedTrack = undefined;
  }

  #listen(track: MediaStreamTrack) {
    if (!this.#ctx || !this.#node || !this.#delay) return;
    this.#source?.disconnect();
    this.#source = this.#ctx.createMediaStreamSource(new MediaStream([track]));
    this.#source.connect(this.#node);
    this.#source.connect(this.#delay);
    this.input = track;
  }

  // A crossfade, so a voice (which RNNoise lets through) stays at the same level at any strength.
  #mix(now: boolean) {
    if (!this.#ctx || !this.#wet || !this.#dry) return;
    const s = Math.min(Math.max(this.#strength, 0), 1);
    const dry = s >= 1 ? 0 : 10 ** (-(s * MAX_REDUCTION_DB) / 20);
    for (const [gain, value] of [[this.#wet.gain, 1 - dry], [this.#dry.gain, dry]] as const) {
      if (now) gain.value = value;
      else gain.setTargetAtTime(value, this.#ctx.currentTime, MIX_GLIDE_S);
    }
  }
}

async function started(ctx: AudioContext) {
  if (ctx.state !== "running") {
    await Promise.race([ctx.resume(), new Promise((resolve) => setTimeout(resolve, START_TIMEOUT_MS))]);
  }
  if (ctx.state !== "running") throw new Error("the noise filter's audio didn't start");
}
