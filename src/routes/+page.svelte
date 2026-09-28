<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { store } from '$lib/store.svelte.ts';
  import Login from '$lib/components/Login.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import ChatPanel from '$lib/components/ChatPanel.svelte';

  onMount(() => { if (store.token) store.boot(); });
  onDestroy(() => store.destroy());
</script>

{#if store.token}
  <div class="app">
    <Sidebar />
    <main class="main">
      <ChatPanel />
    </main>
  </div>
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
</style>
