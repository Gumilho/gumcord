<script lang="ts">
  import { store } from "$lib/store.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import Icon from "$lib/components/Icon.svelte";
  import MemberList from "$lib/components/MemberList.svelte";
  import MemberListToggle from "$lib/components/MemberListToggle.svelte";
  import MessageContent from "$lib/components/MessageContent.svelte";

  let msgEnd: HTMLDivElement | null = $state(null);
  // Updated on scroll only; content growing (an image loading) fires no scroll event,
  // so this still reflects where the reader was before the layout shifted.
  let atBottom = true;
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

  function onMessagesScroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  // An image or link preview appearing pushes content up; follow it only if the reader was at the bottom.
  function onImageLoad() {
    if (atBottom) msgEnd?.scrollIntoView({ block: "end" });
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
  <header class="main-header">
    <span class="header-title"># {store.activeChannel.name}</span>
    <MemberListToggle />
  </header>

  <!-- The header spans the chat and the member list, like Discord. -->
  <div class="chat-body">
    <div class="chat-column">
      <div class="messages" onscroll={onMessagesScroll}>
        {#each store.messages as msg (msg.id)}
          <div class="message">
            <div class="msg-meta">
              <span class="msg-author">{msg.author}</span>
              <span class="msg-time">{formatTime(msg.created_at)}</span>
            </div>
            <MessageContent content={msg.content} onresize={onImageLoad} onview={(src) => (viewing = src)} />
            {#if msg.attachment_url && msg.attachment_type === "image"}
              <button
                class="msg-image-btn"
                type="button"
                aria-label="View image"
                onclick={() => (viewing = msg.attachment_url ?? null)}
              >
                <img
                  class="msg-image"
                  src={msg.attachment_url}
                  alt="attachment"
                  loading="lazy"
                  onload={onImageLoad}
                />
              </button>
            {:else if msg.attachment_url}
              <a class="msg-file" href={msg.attachment_url} target="_blank" rel="noreferrer">
                <Icon name="file" size={16} />
                {fileName(msg.attachment_url)}
              </a>
            {/if}
          </div>
        {/each}
        <div bind:this={msgEnd}></div>
      </div>

      <div class="chat-form">
        <div class="text-area">
          {#if store.uploading || store.pendingAttachment || store.uploadError}
            <div class="attachments">
              {#if store.uploading}
                <div class="upload-status">Uploading…</div>
              {:else if store.uploadError}
                <div class="upload-status error">
                  {store.uploadError}
                  <button type="button" class="dismiss-btn" aria-label="Dismiss" use:tooltip={"Dismiss"} onclick={() => (store.uploadError = "")}>
                    <Icon name="close" size={16} />
                  </button>
                </div>
              {:else if store.pendingAttachment}
                <div class="tile">
                  <div class="tile-media">
                    {#if store.pendingAttachment.type === "image"}
                      <img src={store.pendingAttachment.url} alt={store.pendingAttachment.name} />
                    {:else}
                      <Icon name="file" size={48} />
                    {/if}
                  </div>
                  <span class="tile-name">{store.pendingAttachment.name}</span>
                  <button
                    type="button"
                    class="tile-remove"
                    aria-label="Remove attachment"
                    use:tooltip={"Remove attachment"}
                    onclick={() => (store.pendingAttachment = null)}
                  >
                    <Icon name="trash" size={18} />
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
              use:tooltip={"Upload a file"}
              disabled={store.uploading}
              onclick={() => fileInput?.click()}
            >
              <Icon name="plus" />
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
      </div>
    </div>
    {#if store.showMembers}
      <MemberList />
    {/if}
  </div>
{:else}
  <div class="empty-state">
    {#if store.servers.length === 0}
      {store.me?.admin
        ? "No servers yet. Create one with the + on the left."
        : "You're not in any servers yet. Ask an admin to add you."}
    {:else}
      Select a channel
    {/if}
  </div>
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
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    padding: 0 12px 0 16px;
    border-bottom: 1px solid #2a2d4a;
    font-weight: 600;
    font-size: 15px;
    color: #e8eaf6;
    flex-shrink: 0;
  }

  .header-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-body {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .chat-column {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
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

  .dismiss-btn {
    display: flex;
    padding: 4px;
    border: none;
    border-radius: 4px;
    background: none;
    color: #f87171;
    cursor: pointer;
  }

  .dismiss-btn:hover {
    background: #3a1c24;
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
