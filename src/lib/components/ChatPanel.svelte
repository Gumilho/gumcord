<script lang="ts">
  import { tick } from "svelte";
  import { store, type Emote, type Message } from "$lib/store.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import Icon from "$lib/components/Icon.svelte";
  import MemberList from "$lib/components/MemberList.svelte";
  import MemberListToggle from "$lib/components/MemberListToggle.svelte";
  import VoiceIcon from "$lib/components/VoiceIcon.svelte";
  import MessageContent from "$lib/components/MessageContent.svelte";
  import EmotePicker from "$lib/components/EmotePicker.svelte";
  import BackButton from "$lib/components/BackButton.svelte";
  import { chosenFile, pastedFile } from "$lib/files.ts";
  import { t } from "$lib/i18n.svelte.ts";

  let msgEnd: HTMLDivElement | null = $state(null);
  // Updated on scroll only; content growing (an image loading) fires no scroll event,
  // so this still reflects where the reader was before the layout shifted.
  let atBottom = true;
  let fileInput: HTMLInputElement | null = $state(null);
  let textarea: HTMLTextAreaElement | null = $state(null);
  let viewing: string | null = $state(null);

  // A muted channel's new messages make no sound.
  const channelMuted = $derived(!!store.activeChannel && store.mutedChannels.has(store.activeChannel.id));

  // Grow the textarea with its content (also shrinks back after send clears the draft).
  $effect(() => {
    store.draft;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  });

  // ── Emotes: the picker, and suggestions while typing :name ──
  let pickerOpen = $state(false);
  let caret = $state(0);
  let highlighted = $state(0);
  let dismissed = $state(""); // the search closed with Escape

  const emoteSearch = $derived(/(?:^|\s):([A-Za-z0-9_]{2,32})$/.exec(store.draft.slice(0, caret))?.[1] ?? "");
  const suggestions = $derived.by(() => {
    const q = emoteSearch.toLowerCase();
    if (!q || emoteSearch === dismissed) return [];
    const matches = store.emotes.filter((e) => e.name.toLowerCase().includes(q));
    const starts = (e: Emote) => (e.name.toLowerCase().startsWith(q) ? 0 : 1);
    return matches.sort((a, b) => starts(a) - starts(b)).slice(0, 8);
  });

  function trackCaret() {
    caret = textarea?.selectionStart ?? 0;
  }

  // Puts :name: at the caret, replacing the typed search (and its colon) when there is one.
  async function insertEmote(emote: Emote, replace = 0) {
    const el = textarea;
    if (!el) return;
    const before = store.draft.slice(0, el.selectionStart - replace);
    const text = `${before && !/\s$/.test(before) ? " " : ""}:${emote.name}: `;
    store.draft = before + text + store.draft.slice(el.selectionEnd);
    const at = before.length + text.length;
    await tick();
    el.focus();
    el.setSelectionRange(at, at);
    caret = at;
  }

  function pickEmote(emote: Emote, keepOpen: boolean) {
    void insertEmote(emote);
    if (!keepOpen) pickerOpen = false;
  }

  // Arrows, Enter/Tab and Escape work the suggestions while they're up.
  function onSuggestionKey(e: KeyboardEvent) {
    const n = suggestions.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      highlighted = (highlighted + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      void insertEmote(suggestions[Math.min(highlighted, n - 1)], emoteSearch.length + 1);
    } else if (e.key === "Escape") {
      dismissed = emoteSearch;
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (suggestions.length && !e.isComposing && onSuggestionKey(e)) return;
    // Up in an empty box edits your last message.
    if (e.key === "ArrowUp" && !store.draft) {
      const mine = store.messages.findLast((m) => store.canEdit(m));
      if (mine) {
        e.preventDefault();
        startEdit(mine);
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!store.uploading) store.sendMessage();
    }
  }

  function attach(file: File | null) {
    if (file && !store.uploading) void store.uploadFile(file);
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

  // Scroll to the bottom when a message arrives or another channel opens, not when one is edited or deleted.
  let lastMessageId: number | undefined;
  $effect(() => {
    const last = store.messages.at(-1)?.id;
    if (last === lastMessageId) return;
    lastMessageId = last;
    setTimeout(() => msgEnd?.scrollIntoView({ block: "end" }), 0);
  });

  // ── Editing and deleting messages ──
  let editingId: number | null = $state(null);
  let editText = $state("");
  let deletingId: number | null = $state(null);
  let actionError = $state("");

  function startEdit(msg: Message) {
    editingId = msg.id;
    editText = msg.content;
    deletingId = null;
    actionError = "";
  }

  function stopEdit() {
    editingId = null;
    textarea?.focus();
  }

  async function saveEdit(msg: Message) {
    const content = editText.trim();
    if (content === msg.content.trim()) return stopEdit();
    // Emptying a message is deleting it, as in Discord.
    if (!content && !msg.attachment_url) {
      editingId = null;
      deletingId = msg.id;
      return;
    }
    actionError = await store.editMessage(msg.id, content);
    if (!actionError) stopEdit();
  }

  function onEditKeydown(e: KeyboardEvent, msg: Message) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stopEdit();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void saveEdit(msg);
    }
  }

  // Shift-click deletes straight away; otherwise the message asks first.
  async function askDelete(e: MouseEvent, msg: Message) {
    if (e.shiftKey) return void deleteNow(msg);
    deletingId = msg.id;
    actionError = "";
  }

  async function deleteNow(msg: Message) {
    actionError = await store.deleteMessage(msg.id);
    if (!actionError) deletingId = null;
  }

  // Editing or confirming a delete on the last message would otherwise open below the fold.
  function revealMessage(node: HTMLElement) {
    node.closest(".message")?.scrollIntoView({ block: "nearest" });
  }

  // Grows the edit box with its text, and puts the caret at the end.
  function editBox(node: HTMLTextAreaElement) {
    const fit = () => {
      node.style.height = "auto";
      node.style.height = `${node.scrollHeight}px`;
    };
    fit();
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    revealMessage(node);
    node.addEventListener("input", fit);
    return () => node.removeEventListener("input", fit);
  }

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
    <BackButton />
    <span class="header-title"># {store.activeChannel.name}</span>
    <button
      class="mute-toggle"
      type="button"
      aria-label={t("Mute channel")}
      aria-pressed={channelMuted}
      use:tooltip={t(channelMuted ? "Unmute channel" : "Mute channel")}
      onclick={() => store.activeChannel && store.toggleChannelMute(store.activeChannel.id)}
    >
      <VoiceIcon kind="bell" slashed={channelMuted} />
    </button>
    <MemberListToggle />
  </header>

  <!-- The header spans the chat and the member list, like Discord. -->
  <div class="chat-body">
    <div class="chat-column">
      <div class="messages" onscroll={onMessagesScroll}>
        {#each store.messages as msg (msg.id)}
          <div class="message" class:editing={editingId === msg.id} class:deleting={deletingId === msg.id}>
            {#if editingId !== msg.id && store.canDelete(msg)}
              <div class="msg-actions">
                {#if store.canEdit(msg)}
                  <button type="button" aria-label={t("Edit message")} use:tooltip={t("Edit")} onclick={() => startEdit(msg)}>
                    <Icon name="edit" size={16} />
                  </button>
                {/if}
                <button type="button" class="danger" aria-label={t("Delete message")} use:tooltip={t("Delete")} onclick={(e) => askDelete(e, msg)}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            {/if}
            <div class="msg-meta">
              <span class="msg-author">{msg.author}</span>
              <span class="msg-time">{formatTime(msg.created_at)}</span>
            </div>
            {#if editingId === msg.id}
              <textarea class="edit-input" rows="1" aria-label={t("Edit message")} bind:value={editText} onkeydown={(e) => onEditKeydown(e, msg)} {@attach editBox}></textarea>
              <p class="edit-hint">
                {t("escape to")} <button type="button" onclick={stopEdit}>{t("cancel")}</button> •
                {t("enter to")} <button type="button" onclick={() => saveEdit(msg)}>{t("save")}</button>
              </p>
            {:else}
              <MessageContent content={msg.content} edited={msg.edited_at ? formatTime(msg.edited_at) : ""} onresize={onImageLoad} onview={(src) => (viewing = src)} />
            {/if}
            {#if msg.attachment_url && msg.attachment_type === "image"}
              <button
                class="msg-image-btn"
                type="button"
                aria-label={t("View image")}
                onclick={() => (viewing = msg.attachment_url ?? null)}
              >
                <img
                  class="msg-image"
                  src={msg.attachment_url}
                  alt={t("attachment")}
                  loading="lazy"
                  onload={onImageLoad}
                />
              </button>
            {:else if msg.attachment_url && msg.attachment_type === "sticker"}
              {@const name = store.stickers.find((s) => s.url === msg.attachment_url)?.name ?? t("Sticker")}
              <img class="msg-sticker" src={msg.attachment_url} alt={name} title={name} loading="lazy" onload={onImageLoad} />
            {:else if msg.attachment_url && msg.attachment_type === "video"}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video class="msg-video" src={msg.attachment_url} controls preload="metadata" onloadedmetadata={onImageLoad}></video>
            {:else if msg.attachment_url}
              <a class="msg-file" href={msg.attachment_url} target="_blank" rel="noreferrer">
                <Icon name="file" size={16} />
                {fileName(msg.attachment_url)}
              </a>
            {/if}
            {#if deletingId === msg.id}
              <div class="confirm-delete" role="alertdialog" aria-label={t("Delete message")} {@attach revealMessage}>
                <span>{t("Delete this message?")}</span>
                <button type="button" class="delete-btn" onclick={() => deleteNow(msg)}>{t("Delete")}</button>
                <button type="button" class="cancel-btn" onclick={() => (deletingId = null)}>{t("Cancel")}</button>
              </div>
            {/if}
            {#if actionError && (editingId === msg.id || deletingId === msg.id)}<p class="action-error">{actionError}</p>{/if}
          </div>
        {/each}
        <div bind:this={msgEnd}></div>
      </div>

      <div class="chat-form">
        <div class="text-area">
          {#if store.uploading || store.pendingAttachment || store.uploadError}
            <div class="attachments">
              {#if store.uploading}
                <div class="upload-status">{t("Uploading…")}</div>
              {:else if store.uploadError}
                <div class="upload-status error">
                  {store.uploadError}
                  <button type="button" class="dismiss-btn" aria-label={t("Dismiss")} use:tooltip={t("Dismiss")} onclick={() => (store.uploadError = "")}>
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
                    aria-label={t("Remove attachment")}
                    use:tooltip={t("Remove attachment")}
                    onclick={() => (store.pendingAttachment = null)}
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
              {/if}
            </div>
          {/if}

          <div class="inner">
            <input type="file" hidden bind:this={fileInput} onchange={(e) => attach(chosenFile(e))} />
            <button
              class="attach-btn"
              type="button"
              aria-label={t("Upload a file")}
              use:tooltip={t("Upload a file")}
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
              placeholder={t("Message #{channel}", { channel: store.activeChannel.name })}
              aria-label={t("Message #{channel}", { channel: store.activeChannel.name })}
              onkeydown={onInputKeydown}
              onpaste={(e) => attach(pastedFile(e))}
              oninput={() => { trackCaret(); highlighted = 0; }}
              onkeyup={trackCaret}
              onclick={trackCaret}
            ></textarea>
            <button
              class="attach-btn emote-btn"
              type="button"
              aria-label={t("Emotes and stickers")}
              aria-expanded={pickerOpen}
              use:tooltip={t("Emotes and stickers")}
              onclick={() => (pickerOpen = !pickerOpen)}
            >
              <Icon name="smile" />
            </button>
          </div>
        </div>
        {#if suggestions.length}
          <ul class="suggestions" role="listbox" aria-label={t("Emotes matching :{search}", { search: emoteSearch })}>
            {#each suggestions as emote, i (emote.id)}
              <li role="option" aria-selected={i === Math.min(highlighted, suggestions.length - 1)}>
                <!-- mousedown keeps the focus (and caret) in the message box -->
                <button type="button" tabindex="-1" onmousedown={(e) => e.preventDefault()} onmouseenter={() => (highlighted = i)} onclick={() => insertEmote(emote, emoteSearch.length + 1)}>
                  <img src={emote.url} alt="" />
                  :{emote.name}:
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if pickerOpen}
          <EmotePicker onpick={pickEmote} onclose={() => (pickerOpen = false)} />
        {/if}
      </div>
    </div>
    {#if store.showMembers}
      <MemberList />
    {/if}
  </div>
{:else}
  <header class="main-header empty"><BackButton /></header>
  <div class="empty-state">
    {#if store.servers.length === 0}
      {t(store.me?.admin
        ? "No servers yet. Create one with the + on the left."
        : "You're not in any servers yet. Ask an admin to add you.")}
    {:else}
      {t("Select a channel")}
    {/if}
  </div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === "Escape") viewing = null; }} />

{#if viewing}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox" onclick={() => (viewing = null)}>
    <div class="lightbox-body" role="dialog" aria-modal="true" aria-label={t("Image preview")} tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <img src={viewing} alt={t("attachment")} />
      <a class="lightbox-link" href={viewing} target="_blank" rel="noreferrer">{t("Open in browser")}</a>
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

  /* Like the member list toggle beside it, but kept on phones. */
  .mute-toggle {
    display: flex;
    padding: 4px;
    border: none;
    border-radius: 4px;
    background: none;
    color: #8a90b4;
    cursor: pointer;
    transition: color 0.1s;
  }

  .mute-toggle:hover { color: #e4e6f5; }

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
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 -8px;
    padding: 2px 8px;
    border-radius: 6px;
  }

  .message:hover, .message.editing, .message.deleting { background: #1f2136; }

  /* Edit and delete, over the message's top-right corner while hovered. */
  .msg-actions {
    position: absolute;
    top: -14px;
    right: 12px;
    z-index: 1;
    display: none;
    gap: 2px;
    padding: 2px;
    border: 1px solid #2e3154;
    border-radius: 6px;
    background: #1a1b2e;
    box-shadow: 0 2px 8px #0006;
  }

  .message:hover .msg-actions, .msg-actions:focus-within { display: flex; }

  .msg-actions button {
    display: flex;
    padding: 5px;
    border: none;
    border-radius: 4px;
    background: none;
    color: #8a90b4;
    cursor: pointer;
  }

  .msg-actions button:hover { background: #2a2c48; color: #e4e6f5; }
  .msg-actions button.danger:hover { color: #f87171; }

  .edit-input {
    width: 100%;
    margin-top: 2px;
    padding: 9px 12px;
    border: 1px solid #3f4270;
    border-radius: 8px;
    background: #23253a;
    color: #dbdef0;
    font: inherit;
    font-size: 15px;
    line-height: 22px;
    resize: none;
    outline: none;
  }

  .edit-hint {
    margin: 2px 0 0;
    color: #6b7290;
    font-size: 12px;
  }

  .edit-hint button {
    padding: 0;
    border: none;
    background: none;
    color: #a78bfa;
    font: inherit;
    cursor: pointer;
  }

  .edit-hint button:hover { text-decoration: underline; }

  .confirm-delete {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    color: #c8cce8;
    font-size: 13px;
  }

  .delete-btn, .cancel-btn {
    padding: 5px 12px;
    border: none;
    border-radius: 5px;
    font: 600 13px system-ui, sans-serif;
    cursor: pointer;
  }

  .delete-btn { background: #dc2626; color: #fff; }
  .delete-btn:hover { background: #b91c1c; }
  .cancel-btn { background: #2a2c48; color: #c8cce8; }
  .cancel-btn:hover { background: #33365a; }

  .action-error {
    margin: 2px 0 0;
    color: #f87171;
    font-size: 13px;
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
    position: relative;
    padding: 0 16px 24px;
    flex-shrink: 0;
  }

  .emote-btn { margin: 0 12px 0 0; }

  .suggestions {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: calc(100% - 16px);
    z-index: 40;
    margin: 0;
    padding: 6px;
    list-style: none;
    border: 1px solid #2e3154;
    border-radius: 8px;
    background: #1a1b2e;
    box-shadow: 0 8px 24px #0008;
  }

  .suggestions button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 5px;
    background: none;
    color: #c8cce8;
    font: inherit;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }

  .suggestions [aria-selected="true"] button { background: #2a2c48; color: #fff; }

  .suggestions img {
    width: 24px;
    height: 24px;
    object-fit: contain;
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

  .msg-sticker {
    display: block;
    width: 160px;
    height: 160px;
    margin-top: 4px;
    object-fit: contain;
  }

  .msg-video {
    display: block;
    max-width: min(400px, 100%);
    max-height: 300px;
    margin-top: 4px;
    border-radius: 8px;
    background: #000;
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

  /* Only there for the back button on phones. */
  .main-header.empty { display: none; }

  @media (max-width: 768px) {
    .main-header.empty { display: flex; }
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
