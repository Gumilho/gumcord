<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { store } from "$lib/store.svelte.ts";

  // Set by the desktop app. Its webview can't use passkeys, so sign-in happens in the system browser
  // (window.open is routed there) while this screen polls for the session.
  const desktop = "gumcordDesktop" in window;
  const POLL_MS = 2000;
  // The server keeps a started sign-in for 10 minutes; start a fresh one a little before that.
  const PREPARED_MAX_AGE_MS = 9 * 60_000;

  interface DesktopStart { handle: string; secret: string; code: string; url: string; }

  // Started ahead of the click: window.open must run inside the click itself, or popup blocking drops it.
  let prepared: (DesktopStart & { at: number }) | null = null;
  let pending: { code: string; url: string } | null = $state(null);
  let error = $state("");
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0; // bumped on cancel, so a poll still in flight knows to stop

  async function prepare() {
    try {
      const res = await fetch("/api/auth/desktop/start", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      prepared = { ...(await res.json()), at: Date.now() };
      error = "";
    } catch {
      error = "Can't reach the server.";
    }
  }

  function stopPolling() {
    attempt++;
    clearTimeout(pollTimer);
    pending = null;
  }

  onMount(() => { if (desktop) void prepare(); });
  onDestroy(stopPolling);

  function signIn() {
    stopPolling();
    error = "";
    if (!desktop) {
      location.href = "/api/auth/login";
      return;
    }
    const start = prepared;
    prepared = null;
    if (!start || Date.now() - start.at > PREPARED_MAX_AGE_MS) {
      // Nothing usable yet: get one ready; the next click opens the browser.
      void prepare();
      return;
    }
    const id = attempt;
    pending = { code: start.code, url: new URL(start.url, location.origin).href };
    window.open(pending.url, "_blank");
    pollTimer = setTimeout(() => poll(id, start.handle, start.secret), POLL_MS);
  }

  function cancel() {
    stopPolling();
    void prepare();
  }

  async function poll(id: number, handle: string, secret: string) {
    try {
      const res = await fetch("/api/auth/desktop/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, secret }),
      });
      if (id !== attempt) return;
      if (res.status === 410) {
        stopPolling();
        error = "Sign-in timed out. Try again.";
        void prepare();
        return;
      }
      if (res.ok && (await res.json()).status === "done") {
        stopPolling();
        await store.boot();
        return;
      }
    } catch {
      // Network blip: keep polling until the sign-in expires.
    }
    if (id === attempt) pollTimer = setTimeout(() => poll(id, handle, secret), POLL_MS);
  }
</script>

<div class="login-wrap">
  <div class="login-box">
    <div class="login-logo">G</div>
    <h1>Gumcord</h1>

    {#if pending}
      <p class="login-sub">Finish signing in in your browser. Check that it shows this code:</p>
      <div class="code">{pending.code}</div>
      <div class="actions">
        <button class="btn-primary" type="button" onclick={() => pending && window.open(pending.url, "_blank")}>
          Open browser again
        </button>
        <button class="btn-secondary" type="button" onclick={cancel}>Cancel</button>
      </div>
    {:else}
      <p class="login-sub">Sign in with your PocketID account.</p>
      <button class="btn-primary" type="button" onclick={signIn}>Sign in</button>
    {/if}

    {#if error}
      <p class="login-error">{error}</p>
    {/if}
  </div>
</div>

<style>
  .login-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: #1a1b2e;
  }

  .login-box {
    width: 100%;
    max-width: 340px;
    background: #23253a;
    border: 1px solid #33365a;
    border-radius: 12px;
    padding: 36px 28px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .login-logo {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    background: #5b40c2;
    color: #fff;
    font-weight: 700;
    font-size: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 14px;
  }

  h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 700;
    color: #e8eaf6;
  }

  .login-sub {
    margin: 0 0 20px;
    color: #6b7290;
    font-size: 13px;
    text-align: center;
  }

  .code {
    margin: -4px 0 20px;
    padding: 8px 16px;
    border-radius: 8px;
    background: #1a1b2e;
    color: #e8eaf6;
    font: 700 24px ui-monospace, monospace;
    letter-spacing: 0.12em;
  }

  .actions {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .login-error {
    color: #e57373;
    font-size: 13px;
    margin: 14px 0 0;
    text-align: center;
  }

  .btn-primary,
  .btn-secondary {
    width: 100%;
    padding: 9px 0;
    border-radius: 7px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s;
  }

  .btn-primary {
    border: none;
    background: #5b40c2;
    color: #fff;
  }

  .btn-primary:hover { background: #6d50d6; }

  .btn-secondary {
    border: 1px solid #33365a;
    background: none;
    color: #c8cce8;
  }

  .btn-secondary:hover { background: #2a2d4a; }
</style>
