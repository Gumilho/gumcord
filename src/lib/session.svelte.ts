// Who you are, and every request to the backend. A 401 anywhere means the session ended.
import { t } from "./i18n.svelte.ts";
import { errorText, fetchWithTimeout, UPLOAD_TIMEOUT_MS } from "./net.ts";
import type { ServerItem, User } from "./types.ts";

// Set by the desktop app. Its webview can't use passkeys, so it signs in through the system browser.
export const isDesktop = "gumcordDesktop" in window;
// After signing out, show the sign-in screen instead of going straight back to PocketID.
export const SIGNED_OUT_KEY = "gc_signed_out";

class Session {
  // auth: the session is an HttpOnly cookie, so the server's answer to /me is the only source of truth
  me:        User | null = $state(null);
  signedOut  = $state(false);

  bootError = $state("");
  booted    = $state(false);

  // Tidies up everything else when the server says the session ended. Set by app.svelte.ts, which
  // knows about all the other stores.
  onExpired: () => Promise<void> = async () => {};

  // API request with a timeout. A 401 means the session ended, which drops back to the login screen.
  async api(path: string, init: RequestInit = {}, ms?: number) {
    const res = await fetchWithTimeout(`/api${path}`, init, ms);
    if (res.status === 401 && this.me) void this.onExpired().then(() => this.needSignIn());
    return res;
  }

  // No valid session. The web app goes straight to PocketID; the desktop app, and anyone who just
  // signed out, gets the sign-in screen (which the desktop app needs a click on to open the browser).
  needSignIn() {
    if (!isDesktop && !localStorage.getItem(SIGNED_OUT_KEY)) {
      location.replace("/api/auth/login");
      return;
    }
    this.signedOut = true;
  }

  // Web sign-in from the sign-in screen; the desktop flow lives in Login.svelte.
  signIn() {
    localStorage.removeItem(SIGNED_OUT_KEY);
    location.href = "/api/auth/login";
  }

  isMe(identity: string) {
    return identity === String(this.me?.id);
  }

  // Whoever added an emote, sticker or sound, or an admin, can remove it.
  canRemove(item: ServerItem) {
    return !!this.me && (this.me.admin || this.me.id === item.created_by);
  }

  // A change the server answers with nothing but success or a reason: returns the error to show, or
  // "". The server's live update refreshes everyone, this client included. Forms are uploads.
  async submit(path: string, method: string, body?: unknown): Promise<string> {
    const form = body instanceof FormData;
    try {
      const res = await this.api(path, {
        method,
        headers: body && !form ? { "Content-Type": "application/json" } : undefined,
        body: form ? body : body ? JSON.stringify(body) : undefined,
      }, form ? UPLOAD_TIMEOUT_MS : undefined);
      return res.ok ? "" : await errorText(res);
    } catch {
      return t("Can't reach the server.");
    }
  }

  // ── Your profile ──────────────────────────────────────────

  // Each returns an error message, or "" on success. An empty name goes back to your PocketID name.
  updateName(name: string) {
    return this.#profileRequest("/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  }

  setAvatar(file: File) {
    const form = new FormData();
    form.append("file", file);
    return this.#profileRequest("/me/avatar", { method: "PUT", body: form }, UPLOAD_TIMEOUT_MS);
  }

  resetAvatar() {
    return this.#profileRequest("/me/avatar", { method: "DELETE" });
  }

  async #profileRequest(path: string, init: RequestInit, ms?: number): Promise<string> {
    try {
      const res = await this.api(path, init, ms);
      if (!res.ok) return await errorText(res);
      // The server also updates any call you're in, name and picture in one request. (Doing it from
      // here would race: each LiveKit update carries the others' current values.)
      this.me = await res.json();
      return "";
    } catch {
      return t("Can't reach the server.");
    }
  }
}

export const session = new Session();
