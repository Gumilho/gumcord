<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { store } from '$lib/store.svelte.ts';
  import Login from '$lib/components/Login.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import CallPanel from '$lib/components/CallPanel.svelte';

  onMount(() => { if (store.token) store.boot(); });
  onDestroy(() => store.destroy());

  const SPLASH_MIN_MS = 1000;

  // The splash lives in app.html so it paints before JS; hide it once there's something to show.
  $effect(() => {
    if (store.token && !store.booted && !store.bootError) return;
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

{#if store.token}
  {#if store.bootError}
    <div class="boot-error">
      <p>{store.bootError}</p>
      <button onclick={() => store.boot()}>Retry</button>
    </div>
  {:else}
    <div class="app">
      <Sidebar />
      <main class="main">
        {#if store.mainView === "call" && store.room}
          <CallPanel />
        {:else}
          <ChatPanel />
        {/if}
      </main>
    </div>
  {/if}
{:else}
  <Login />
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(html, body) {
    height: 100%;
    margin: 0;
    background: #1a1b2e;
    color: #d4d8f0;
    font-family: system-ui, sans-serif;
    font-size: 14px;
  }

  .app {
    height: 100vh;
    display: flex;
    overflow: hidden;
  }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #1a1b2e;
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

  :global(.gc-tooltip) {
    position: fixed;
    z-index: 1000;
    padding: 6px 10px;
    border-radius: 6px;
    background: #0f1020;
    color: #e4e6f5;
    font: 600 13px system-ui, sans-serif;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 4px 14px #0008;
  }

  :global(.gc-tooltip::after) {
    content: "";
    position: absolute;
    top: 100%;
    left: var(--arrow-x, 50%);
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: #0f1020;
  }
</style>
