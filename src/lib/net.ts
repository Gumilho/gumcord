// Talking to the backend: addresses, requests that time out, and the reason a request failed.
import { serverMessage, t } from "./i18n.svelte.ts";

export const REQUEST_TIMEOUT_MS = 10_000;
export const UPLOAD_TIMEOUT_MS  = 120_000;

// The app, API and LiveKit share one origin (Vite proxies them in development).
export function wsUrl(path = "") {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
}

// A stalled server should surface as an error, not an endless load.
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (init.signal?.aborted) ctrl.abort();
  init.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// What went wrong, from a failed response: the server's reason in the app's language.
export async function errorText(res: Response) {
  const text = (await res.text()).trim();
  return text ? serverMessage(text) : t("Failed ({status}).", { status: res.status });
}
