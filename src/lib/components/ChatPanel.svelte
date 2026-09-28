<script lang="ts">
  import { store } from "$lib/store.svelte.ts";
  import { API_BASE } from "$lib/config.js";

  let msgEnd: HTMLDivElement | null = $state(null);
  let fileInput: HTMLInputElement | null = $state(null);
  let textarea: HTMLTextAreaElement | null = $state(null);
  let viewing: string | null = $state(null);

  // Grow the textarea with its content (also shrinks back after send clears the draft).
  $effect(() => {
    store.draft;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  });

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!store.uploading) store.sendMessage();
    }
  }

  function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) store.uploadFile(file);
  }

  function fileName(url: string) {
    return url.split("/").pop() ?? url;
  }

  // Scroll to bottom whenever messages change
  $effect(() => {
    store.messages;
    setTimeout(() => msgEnd?.scrollIntoView({ block: "end" }), 0);
  });

  function formatTime(raw: string) {
    if (!raw) return "";
    // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"; already-ISO strings pass through
    const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
        {#if msg.content}
          <p class="msg-content">{msg.content}</p>
        {/if}
        {#if msg.attachment_url && msg.attachment_type === "image"}
          <button
            class="msg-image-btn"
            type="button"
            aria-label="View image"
            onclick={() => (viewing = `${API_BASE}${msg.attachment_url}`)}
          >
            <img
              class="msg-image"
              src="{API_BASE}{msg.attachment_url}"
              alt="attachment"
              loading="lazy"
              onload={() => msgEnd?.scrollIntoView({ block: "end" })}
            />
          </button>
        {:else if msg.attachment_url}
          <a class="msg-file" href="{API_BASE}{msg.attachment_url}" target="_blank" rel="noreferrer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path fill="currentColor" d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.41a2 2 0 0 0-.59-1.41l-4.41-4.41A2 2 0 0 0 13.59 2H6Zm7 1.5V8a1 1 0 0 0 1 1h4.5L13 3.5Z" />
            </svg>
            {fileName(msg.attachment_url)}
          </a>
        {/if}
      </div>
    {/each}
    <div bind:this={msgEnd}></div>
  </div>

  <form
    class="chat-form"
    onsubmit={(e) => {
      e.preventDefault();
      store.sendMessage();
    }}
  >
    <div class="text-area">
      {#if store.uploading || store.pendingAttachment || store.uploadError}
        <div class="attachments">
          {#if store.uploading}
            <div class="upload-status">Uploading…</div>
          {:else if store.uploadError}
            <div class="upload-status error">
              {store.uploadError}
              <button type="button" class="tile-remove inline" title="Dismiss" onclick={() => (store.uploadError = "")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" /></svg>
              </button>
            </div>
          {:else if store.pendingAttachment}
            <div class="tile">
              <div class="tile-media">
                {#if store.pendingAttachment.type === "image"}
                  <img src="{API_BASE}{store.pendingAttachment.url}" alt={store.pendingAttachment.name} />
                {:else}
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.41a2 2 0 0 0-.59-1.41l-4.41-4.41A2 2 0 0 0 13.59 2H6Zm7 1.5V8a1 1 0 0 0 1 1h4.5L13 3.5Z" /></svg>
                {/if}
              </div>
              <span class="tile-name">{store.pendingAttachment.name}</span>
              <button type="button" class="tile-remove" title="Remove attachment" onclick={() => (store.pendingAttachment = null)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5ZM5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07Z" /></svg>
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <div class="inner">
        <input type="file" hidden bind:this={fileInput} onchange={onFilePicked} />
        <button
          class="attach-btn"
          type="button"
          aria-label="Upload a file"
          title="Upload a file"
          disabled={store.uploading}
          onclick={() => fileInput?.click()}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path fill="currentColor" d="M13 3a1 1 0 1 0-2 0v8H3a1 1 0 1 0 0 2h8v8a1 1 0 0 0 2 0v-8h8a1 1 0 0 0 0-2h-8V3Z" />
          </svg>
        </button>
        <textarea
          class="msg-input"
          rows="1"
          bind:this={textarea}
          bind:value={store.draft}
          placeholder="Message #{store.activeChannel.name}"
          aria-label="Message #{store.activeChannel.name}"
          onkeydown={onInputKeydown}
        ></textarea>
      </div>
    </div>
  </form>
{:else}
  <div class="empty-state">Select a channel</div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === "Escape") viewing = null; }} />

{#if viewing}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox" onclick={() => (viewing = null)}>
    <div class="lightbox-body" role="dialog" aria-modal="true" aria-label="Image preview" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <img src={viewing} alt="attachment" />
      <a class="lightbox-link" href={viewing} target="_blank" rel="noreferrer">Open in browser</a>
    </div>
  </div>
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
    white-space: pre-wrap;
  }

  /* ── Chat input (Discord layout) ── */
  .chat-form {
    padding: 0 16px 24px;
    flex-shrink: 0;
  }

  .text-area {
    background: #23253a;
    border-radius: 8px;
    border: 1px solid #2e3154;
  }

  .text-area:focus-within {
    border-color: #3f4270;
  }

  .inner {
    display: flex;
    align-items: flex-start;
    padding-left: 16px;
  }

  .attach-btn {
    position: sticky;
    top: 0;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 44px;
    margin-right: 12px;
    padding: 0;
    border: none;
    background: none;
    color: #8a90b4;
    cursor: pointer;
    transition: color 0.1s;
  }

  .attach-btn:hover:not(:disabled) {
    color: #e4e6f5;
  }

  .attach-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .msg-input {
    flex: 1;
    min-height: 44px;
    max-height: 50vh;
    padding: 11px 16px 11px 0;
    border: none;
    background: none;
    color: #dbdef0;
    font: inherit;
    font-size: 15px;
    line-height: 22px;
    resize: none;
    outline: none;
    overflow-y: auto;
  }

  .msg-input::placeholder {
    color: #5c6283;
  }

  /* ── Attachment tiles (inside the input box) ── */
  .attachments {
    display: flex;
    gap: 24px;
    padding: 20px 10px 10px;
    border-bottom: 1px solid #2e3154;
    overflow-x: auto;
  }

  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 216px;
    padding: 8px;
    border-radius: 4px;
    background: #1c1e33;
  }

  .tile-media {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 160px;
    border-radius: 3px;
    background: #16172a;
    color: #6b7290;
    overflow: hidden;
  }

  .tile-media img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .tile-name {
    margin-top: 8px;
    color: #c8cce8;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tile-remove {
    position: absolute;
    top: -12px;
    right: -12px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid #2e3154;
    border-radius: 4px;
    background: #23253a;
    color: #f87171;
    cursor: pointer;
    box-shadow: 0 2px 8px #0006;
  }

  .tile-remove:hover {
    background: #3a1c24;
  }

  .tile-remove.inline {
    position: static;
    width: 24px;
    height: 24px;
    border: none;
    box-shadow: none;
    background: none;
  }

  .upload-status {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #8a90b4;
    font-size: 13px;
  }

  .upload-status.error {
    color: #f87171;
  }

  .msg-image-btn {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
  }

  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #06071099;
    backdrop-filter: blur(2px);
  }

  .lightbox-body {
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .lightbox-body img {
    display: block;
    max-width: 90vw;
    max-height: 80vh;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 8px 32px #0009;
  }

  .lightbox-link {
    color: #c8cce8;
    font-size: 14px;
    text-decoration: none;
    opacity: 0.8;
  }

  .lightbox-link:hover {
    opacity: 1;
    text-decoration: underline;
  }

  .msg-image {
    display: block;
    max-width: min(400px, 100%);
    max-height: 300px;
    margin-top: 4px;
    border-radius: 8px;
    object-fit: contain;
    background: #23253a;
  }

  .msg-file {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    margin-top: 4px;
    padding: 8px 12px;
    border: 1px solid #33365a;
    border-radius: 6px;
    background: #23253a;
    color: #a78bfa;
    font-size: 13px;
    text-decoration: none;
  }

  .msg-file:hover {
    text-decoration: underline;
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
