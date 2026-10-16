// The live connection to the backend: messages, who's online, who's in voice, changes to servers.
// It reconnects by itself, backing off. What each event means is for app.svelte.ts to say.
import { wsUrl } from "./net.ts";
import { session } from "./session.svelte.ts";

const WS_RECONNECT_BASE = 1_000;  // ms
const WS_RECONNECT_MAX  = 30_000; // ms
// The server sends a heartbeat every 25 s. A connection that has said nothing for this long is dead,
// even if the browser hasn't noticed (after sleep, or a network change).
const WS_SILENT_MAX     = 60_000; // ms
const WS_WATCH_EVERY    = 10_000; // ms
// Coming back to the window, a connection quiet for more than a heartbeat is checked sooner.
const WS_SILENT_ON_WAKE = 30_000; // ms

class Socket {
  #ws:         WebSocket | null = null;
  #retries     = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #onEvent:    (data: unknown) => void = () => {};
  #stopped     = false;
  #lastHeard   = 0;
  #watchdog:   ReturnType<typeof setInterval> | null = null;

  // Opens the connection, and keeps it open until close(). Does nothing when signed out.
  connect(onEvent: (data: unknown) => void) {
    this.#onEvent = onEvent;
    this.#stopped = false;
    this.#open();
    this.#watchdog ??= setInterval(() => this.#checkAlive(WS_SILENT_MAX), WS_WATCH_EVERY);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.#onWake);
      window.addEventListener("online", this.#onWake);
      document.addEventListener("visibilitychange", this.#onWake);
    }
  }

  #onWake = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") this.#checkAlive(WS_SILENT_ON_WAKE);
  };

  // Drops a connection that has gone quiet and opens a new one right away.
  #checkAlive(maxSilence: number) {
    if (this.#stopped || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.#lastHeard < maxSilence) return;
    const ws = this.#ws;
    this.#ws = null;
    ws.onclose = ws.onmessage = null;
    ws.close();
    this.#retries = 0;
    this.#open();
  }

  // False when it isn't connected (right now, or until it reconnects), so the caller can say so.
  send(data: unknown) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(data));
    return true;
  }

  // For good: no reconnecting.
  close() {
    this.#stopped = true;
    clearTimeout(this.#retryTimer ?? undefined);
    this.#retryTimer = null;
    this.#retries    = 0;
    clearInterval(this.#watchdog ?? undefined);
    this.#watchdog = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.#onWake);
      window.removeEventListener("online", this.#onWake);
      document.removeEventListener("visibilitychange", this.#onWake);
    }
    this.#ws?.close();
    this.#ws = null;
  }

  #open() {
    if (this.#ws || !session.me) return;
    const ws = (this.#ws = new WebSocket(wsUrl("/api/ws")));
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.#lastHeard = Date.now();
      this.#retries = 0; // successful connection resets backoff
    };

    ws.onmessage = (e) => {
      let data: unknown;
      try { data = JSON.parse(e.data); } catch { return; }
      this.#lastHeard = Date.now();
      if ((data as { type?: unknown } | null)?.type === "ping") return;
      this.#onEvent(data);
    };

    ws.onclose = () => {
      this.#ws = null;
      if (this.#stopped || !session.me) return; // signed out: don't reconnect
      // A refused handshake may be an expired session; session.api signs out if so.
      if (!opened) void session.api("/me").catch(() => {});
      const delay = Math.min(WS_RECONNECT_BASE * 2 ** this.#retries, WS_RECONNECT_MAX);
      this.#retries++;
      this.#retryTimer = setTimeout(() => this.#open(), delay);
    };
  }
}

export const socket = new Socket();
