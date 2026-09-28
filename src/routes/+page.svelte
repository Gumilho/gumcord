<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { store } from '$lib/store.svelte.ts';
  import Login from '$lib/components/Login.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import CallPanel from '$lib/components/CallPanel.svelte';

  onMount(() => store.boot());
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
    <button onclick={() => store.boot()}>Retry</button>
  </div>
{:else if store.signedOut}
  <Login />
{:else if store.me}
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

<style>
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
