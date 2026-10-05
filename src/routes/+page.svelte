<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { app } from '$lib/app.svelte.ts';
  import { chat } from '$lib/chat.svelte.ts';
  import { session } from '$lib/session.svelte.ts';
  import { ui } from '$lib/ui.svelte.ts';
  import { voice } from '$lib/voice.svelte.ts';
  import Login from '$lib/components/Login.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import CallPanel from '$lib/components/CallPanel.svelte';
  import UserAudioMenu from '$lib/components/UserAudioMenu.svelte';
  import ServerRail from '$lib/components/ServerRail.svelte';
  import { installShortcuts } from '$lib/shortcuts.svelte.ts';
  import { t } from '$lib/i18n.svelte.ts';
  import { dragStart, mobile, showMain } from '$lib/mobile.svelte.ts';

  onMount(() => {
    void app.boot();
    return installShortcuts();
  });
  onDestroy(() => app.destroy());

  // An expanded call takes the whole window on a larger screen; a phone already shows it alone.
  const callFills = $derived(ui.callExpanded && !mobile.narrow && ui.mainView === "call" && !!voice.room);

  // For the keyboard: past the server and channel lists to the chat or call. On a phone that
  // means bringing it forward first.
  async function skipToMain(e: MouseEvent) {
    e.preventDefault();
    showMain();
    await tick();
    document.getElementById("main")?.focus();
  }

  const SPLASH_MIN_MS = 1000;

  // The splash lives in app.html so it paints before JS; hide it once there's something to show.
  $effect(() => {
    if (!session.booted && !session.bootError && !session.signedOut) return;
    const splash = document.getElementById("splash");
    if (!splash || splash.dataset.hiding) return;
    splash.dataset.hiding = "1";
    // performance.now() counts from page navigation, so this is time since the reload started.
    const wait = Math.max(0, SPLASH_MIN_MS - performance.now());
    setTimeout(() => {
      splash.classList.add("hidden");
      setTimeout(() => splash.remove(), 300);
    }, wait);
  });
</script>

{#if session.bootError}
  <div class="boot-error">
    <p>{session.bootError}</p>
    <button onclick={() => app.boot()}>{t("Retry")}</button>
  </div>
{:else if session.signedOut}
  <Login />
{:else if session.me}
  <a class="skip-link" href="#main" onclick={skipToMain}>{t("Skip to main content")}</a>
  <!-- On a phone the chat or call slides over the channel list, following a sideways drag. The
       drags are shortcuts: the back button and the channel list do the same with a tap. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="app"
    class:show-nav={mobile.pane === "nav"}
    class:dragging={mobile.drag !== null}
    ontouchstart={(e) => dragStart(e, !!(chat.activeChannel || voice.room))}
  >
    <!-- Just the server list and sidebar side by side on a larger screen. -->
    <div class="nav-pane" class:hidden={callFills} inert={mobile.narrow && mobile.pane === "main" && mobile.drag === null}>
      <ServerRail />
      <Sidebar />
    </div>
    <main
      id="main"
      tabindex="-1"
      class="main"
      inert={mobile.narrow && mobile.pane === "nav" && mobile.drag === null}
      style:transform={mobile.drag !== null ? `translateX(${mobile.drag}px)` : undefined}
    >
      {#if ui.mainView === "call" && voice.room}
        <CallPanel />
      {:else}
        <ChatPanel />
      {/if}
    </main>
  </div>
  <UserAudioMenu />
{/if}

<style>
  .app {
    height: 100vh;
    height: 100dvh; /* phones: the visible height, without the browser's toolbars */
    display: flex;
    overflow: hidden;
    /* Not scrollable even by script: on a phone the chat waits off to the side while the channel
       list shows, and scrollIntoView (the chat jumping to its newest message after a server
       switch) would otherwise scroll this box over to it, leaving the panes out of step. */
    overflow: clip;
  }

  .nav-pane { display: contents; }
  .nav-pane.hidden { display: none; }

  /* Phones: the channel list stays put underneath; the chat or call slides over it. */
  @media (max-width: 768px) {
    .app { position: relative; }

    .nav-pane, .main {
      position: absolute;
      inset: 0;
    }

    .nav-pane { display: flex; }

    .main {
      z-index: 1;
      background: #1a1b2e;
      box-shadow: -6px 0 18px #0009;
      transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 0.25s;
    }

    .app.show-nav .main { transform: translateX(100%); }
    .app.show-nav:not(.dragging) .main { box-shadow: none; }
    /* Under the finger: no easing, it's exactly where the finger is. */
    .app.dragging .main { transition: none; }
  }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Focused only by the skip link, and only to move the keyboard here: nothing to outline. */
  .main:focus { outline: none; }

  .boot-error {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    color: #e57373;
  }

  .boot-error button {
    padding: 8px 20px;
    border-radius: 7px;
    border: 1px solid #e57373;
    background: none;
    color: #e57373;
    cursor: pointer;
    font-size: 14px;
  }

  .boot-error button:hover { background: #2a1a1a; }
</style>
