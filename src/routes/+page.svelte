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
  import { mobile, showMain, showNav, swipeEnd, swipeStart } from '$lib/mobile.svelte.ts';

  onMount(() => {
    void store.boot();
    return installShortcuts();
  });
  onDestroy(() => store.destroy());

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
  <div class="app" class:show-nav={mobile.pane === "nav"}>
    <!-- One pane on a phone, just the server list and sidebar side by side otherwise. The swipes
         are shortcuts: the back button and the channel list do the same with a tap. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="nav-pane"
      inert={mobile.narrow && mobile.pane === "main"}
      ontouchstart={swipeStart}
      ontouchend={(e) => { if (swipeEnd(e) < 0 && (store.activeChannel || store.room)) showMain(); }}
    >
      <ServerRail />
      <Sidebar />
    </div>
    <main
      class="main"
      inert={mobile.narrow && mobile.pane === "nav"}
      ontouchstart={swipeStart}
      ontouchend={(e) => { if (swipeEnd(e) > 0) showNav(); }}
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

  /* Phones: the two panes stacked, sliding sideways. */
  @media (max-width: 768px) {
    .app { position: relative; }

    .nav-pane, .main {
      position: absolute;
      inset: 0;
      transition: transform 0.22s ease;
    }

    .nav-pane {
      display: flex;
      transform: translateX(-100%);
    }

    .app.show-nav .nav-pane { transform: none; }
    .app.show-nav .main { transform: translateX(100%); }
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
