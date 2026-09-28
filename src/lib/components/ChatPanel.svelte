<script lang="ts">
  import { store } from "$lib/store.svelte.ts";

  let msgEnd: HTMLDivElement | null = $state(null);

  // Scroll to bottom whenever messages change
  $effect(() => {
    store.messages;
    setTimeout(() => msgEnd?.scrollIntoView({ block: "end" }), 0);
  });

  function formatTime(raw: string) {
    return new Date(raw.replace(" ", "T") + "Z").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

{#if store.activeChannel}
  <header class="main-header"># {store.activeChannel.name}</header>

  <div class="messages">
    {#each store.messages as msg (msg.id)}
      <div class="message">
        <div class="msg-meta">
          <span class="msg-author">{msg.username}</span>
          <span class="msg-time">{formatTime(msg.created_at)}</span>
        </div>
        <p class="msg-content">{msg.content}</p>
      </div>
    {/each}
    <div bind:this={msgEnd}></div>
  </div>

  <form
    class="input-bar"
    onsubmit={(e) => {
      e.preventDefault();
      store.sendMessage();
    }}
  >
    <input
      class="msg-input"
      type="text"
      placeholder="Message #{store.activeChannel.name}"
      bind:value={store.draft}
    />
    <button class="btn-send" type="submit">Send</button>
  </form>
{:else}
  <div class="empty-state">Select a channel</div>
{/if}

<style>
  .main-header {
    padding: 12px 16px;
    border-bottom: 1px solid #2a2d4a;
    font-weight: 600;
    font-size: 15px;
    color: #e8eaf6;
    flex-shrink: 0;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .message {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .msg-meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .msg-author {
    font-weight: 600;
    font-size: 13.5px;
    color: #9d82e0;
  }

  .msg-time {
    font-size: 11px;
    color: #4a5168;
  }

  .msg-content {
    margin: 0;
    color: #c8cce8;
    line-height: 1.5;
    word-break: break-word;
  }

  .input-bar {
    padding: 10px 16px;
    display: flex;
    gap: 8px;
    border-top: 1px solid #2a2d4a;
    flex-shrink: 0;
  }

  .msg-input {
    flex: 1;
    padding: 9px 12px;
    border-radius: 7px;
    border: 1px solid #33365a;
    background: #23253a;
    color: #d4d8f0;
    font-size: 14px;
    outline: none;
  }

  .msg-input:focus {
    border-color: #7c5cbf;
  }

  .btn-send {
    padding: 9px 16px;
    border-radius: 7px;
    border: none;
    background: #5b40c2;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-send:hover {
    background: #6d50d6;
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #4a5168;
    font-size: 15px;
  }
</style>
