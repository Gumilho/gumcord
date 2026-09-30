<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { store } from '$lib/store.svelte.ts';
  import Login from '$lib/components/Login.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import CallPanel from '$lib/components/CallPanel.svelte';
  import UserAudioMenu from '$lib/components/UserAudioMenu.svelte';
  import ServerRail from '$lib/components/ServerRail.svelte';
  import { installShortcuts } from '$lib/shortcuts.svelte.ts';
  import { t } from '$lib/i18n.svelte.ts';
  import { dragEnd, dragMove, dragStart, mobile } from '$lib/mobile.svelte.ts';

  onMount(() => {
    void store.boot();
    return installShortcuts();
  });
  onDestroy(() => store.destroy());

  // An expanded call takes the whole window on a larger screen; a phone already shows it alone.
  const callFills = $derived(store.callExpanded && !mobile.narrow && store.mainView === "call" && !!store.room);

  const SPLASH_MIN_MS = 1000;

  // The splash lives in app.html so it paints before JS; hide it once there's something to show.
  $effect(() => {
    if (!store.booted && !store.bootError && !store.signedOut) return;
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

{#if store.bootError}
  <div class="boot-error">
    <p>{store.bootError}</p>
    <button onclick={() => store.boot()}>{t("Retry")}</button>
  </div>
{:else if store.signedOut}
  <Login />
{:else if store.me}
  <!-- On a phone the chat or call slides over the channel list, following a sideways drag. The
       drags are shortcuts: the back button and the channel list do the same with a tap. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="app"
    class:show-nav={mobile.pane === "nav"}
    class:dragging={mobile.drag !== null}
    ontouchstart={(e) => dragStart(e, !!(store.activeChannel || store.room))}
    ontouchmove={dragMove}
    ontouchend={dragEnd}
    ontouchcancel={dragEnd}
  >
    <!-- Just the server list and sidebar side by side on a larger screen. -->
    <div class="nav-pane" class:hidden={callFills} inert={mobile.narrow && mobile.pane === "main" && mobile.drag === null}>
      <ServerRail />
      <Sidebar />
    </div>
    <main
      class="main"
      inert={mobile.narrow && mobile.pane === "nav" && mobile.drag === null}
      style:transform={mobile.drag !== null ? `translateX(${mobile.drag}px)` : undefined}
    >
      {#if store.mainView === "call" && store.room}
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
