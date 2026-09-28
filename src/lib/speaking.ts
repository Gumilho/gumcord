// Client-side voice activity detection. LiveKit's server-side active-speaker updates arrive
// every ~400ms and are smoothed, which makes the speaking ring lag by about a second.

const SPEAKING_DBFS = -45; // close to LiveKit's server default (35 dBov), with a little headroom
const HOLD_MS       = 250; // keeps the ring on through the short gaps between words
const POLL_MS       = 50;

interface Watched {
  source:   MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf:      Float32Array<ArrayBuffer>;
  lastLoud: number;
}

export class SpeakingDetector {
  #ctx: AudioContext | null = null;
  #watched = new Map<string, Watched>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #speaking = new Set<string>();
  #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  get speaking(): ReadonlySet<string> {
    return this.#speaking;
  }

  // Created without a user gesture (e.g. auto-rejoin after refresh), the context starts suspended.
  get running() {
    return this.#ctx?.state === "running";
  }

  prepare() {
    this.#ctx ??= new AudioContext();
  }

  async resume() {
    await this.#ctx?.resume();
    this.#onChange();
  }

  watch(id: string, track: MediaStreamTrack) {
    this.unwatch(id);
    this.prepare();
    const ctx = this.#ctx!;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    this.#watched.set(id, { source, analyser, buf: new Float32Array(analyser.fftSize), lastLoud: 0 });
    this.#timer ??= setInterval(() => this.#tick(), POLL_MS);
  }

  unwatch(id: string) {
    const w = this.#watched.get(id);
    if (!w) return;
    w.source.disconnect();
    this.#watched.delete(id);
    if (this.#speaking.delete(id)) this.#onChange();
    if (this.#watched.size === 0 && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  clear() {
    for (const id of [...this.#watched.keys()]) this.unwatch(id);
  }

  dispose() {
    this.clear();
    void this.#ctx?.close();
    this.#ctx = null;
  }

  #tick() {
    const now = performance.now();
    const next = new Set<string>();
    for (const [id, w] of this.#watched) {
      w.analyser.getFloatTimeDomainData(w.buf);
      let sumSq = 0;
      for (const x of w.buf) sumSq += x * x;
      // 10·log10(mean square) is 20·log10(RMS), i.e. level in dBFS.
      const dbfs = 10 * Math.log10(sumSq / w.buf.length || 1e-12);
      if (dbfs > SPEAKING_DBFS) w.lastLoud = now;
      if (now - w.lastLoud < HOLD_MS) next.add(id);
    }
    if (next.size !== this.#speaking.size || [...next].some((id) => !this.#speaking.has(id))) {
      this.#speaking = next;
      this.#onChange();
    }
  }
}
