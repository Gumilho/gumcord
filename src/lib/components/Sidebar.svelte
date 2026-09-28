<script lang="ts">
  import { store } from "$lib/store.svelte.ts";
  import { ConnectionQuality } from "livekit-client";
  import { tooltip } from "$lib/tooltip.ts";
  import VoiceIcon from "$lib/components/VoiceIcon.svelte";

  type MenuItem = { label: string; action: () => void; danger?: boolean };
  type MenuState = { x: number; y: number; items: MenuItem[] };
  type Channel = { id: number; name: string; kind: string };

  function initial(name: string) { return name.charAt(0).toUpperCase(); }

  // Starting a share jumps to the call view so you can see what you're sharing; stopping stays put.
  function shareFromPanel() {
    if (!store.canScreenShare) return;
    if (!store.screenSharing) store.mainView = "call";
    // Called synchronously from the click so the browser still counts it as a user gesture.
    void store.toggleScreenShare();
  }

  function qualityClass(q: ConnectionQuality) {
    if (q === ConnectionQuality.Poor) return "poor";
    if (q === ConnectionQuality.Lost) return "lost";
    return "good";
  }

  function qualityLabel(q: ConnectionQuality) {
    return {
      [ConnectionQuality.Excellent]: "excellent",
      [ConnectionQuality.Good]: "good",
      [ConnectionQuality.Poor]: "poor",
      [ConnectionQuality.Lost]: "lost",
      [ConnectionQuality.Unknown]: "checking…",
    }[q];
  }

  const WIDTH_KEY  = "gc_sidebar_width";
  const MIN_WIDTH  = 264;
  const MAX_WIDTH  = 432;
  const KEY_STEP   = 16;

  const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

  let width = $state(clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || MIN_WIDTH));
  let resizing = $state(false);

  // Keep the resize cursor and block text selection page-wide while dragging.
  $effect(() => {
    document.body.classList.toggle("resizing-sidebar", resizing);
  });

  function saveWidth() {
    localStorage.setItem(WIDTH_KEY, String(width));
  }

  function startResize(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startWidth = width;
    handle.setPointerCapture(e.pointerId);
    resizing = true;

    const move = (ev: PointerEvent) => { width = clampWidth(startWidth + ev.clientX - startX); };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      resizing = false;
      saveWidth();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function resizeWithKeys(e: KeyboardEvent) {
    const delta = { ArrowLeft: -KEY_STEP, ArrowRight: KEY_STEP }[e.key];
    let next: number | undefined;
    if (delta) next = width + delta;
    else if (e.key === "Home") next = MIN_WIDTH;
    else if (e.key === "End") next = MAX_WIDTH;
    if (next === undefined) return;
    e.preventDefault();
    width = clampWidth(next);
    saveWidth();
  }

  let menu: MenuState | null = $state(null);
  let creating: 'text' | 'voice' | null = $state(null);
  let createName = $state('');

  function focus(node: HTMLElement) { node.focus(); }
  function closeMenu() { menu = null; }

  function openMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    const menuH = items.length * 36 + 8;
    const menuW = 192;
    menu = {
      x: Math.min(e.clientX, window.innerWidth - menuW - 8),
      y: Math.min(e.clientY, window.innerHeight - menuH - 8),
      items,
    };
  }

  function onNavContext(e: MouseEvent) {
    openMenu(e, [
      { label: 'New Text Channel', action: () => startCreate('text') },
      { label: 'New Voice Channel', action: () => startCreate('voice') },
    ]);
  }

  function onChannelContext(e: MouseEvent, ch: Channel) {
    e.stopPropagation();
    if (ch.kind === 'voice') {
      openMenu(e, store.voiceChannel?.id === ch.id
        ? [
            { label: 'Open Call', action: () => store.openVoiceChannel(ch) },
            { label: 'Leave Channel', action: () => store.leaveVoice(), danger: true },
          ]
        : [{ label: store.room ? 'Switch to Channel' : 'Join Channel', action: () => store.openVoiceChannel(ch) }]);
    } else {
      e.preventDefault(); // suppress browser menu for text channels
    }
  }

  function startCreate(kind: 'text' | 'voice') {
    creating = kind;
    createName = '';
  }

  async function confirmCreate() {
    const name = createName.trim();
    if (!name || !creating) return;
    await store.createChannel(name, creating);
    creating = null;
    createName = '';
  }

  function cancelCreate() {
    creating = null;
    createName = '';
  }
</script>

<svelte:window
  onkeydown={(e) => { if (e.key === 'Escape') { closeMenu(); cancelCreate(); } }}
/>

<aside class="sidebar" style="width: {width}px">
  <!-- Header -->
  <div class="sidebar-header">
    <span class="sidebar-title">Gumcord</span>
    <button class="icon-btn" title="Log out" onclick={() => store.logout()}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path
          fill="currentColor"
          d="M8 4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5a1 1 0 1 1 0 2H8a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3h5a1 1 0 1 1 0 2H8ZM15.7 7.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4-1.4L18.58 12l-2.88-2.3a1 1 0 0 1-.3-.7 1 1 0 0 1 .3-.7Z"
        />
      </svg>
    </button>
  </div>

  <!-- Channels list -->
  <nav class="channels" oncontextmenu={onNavContext}>
    <!-- Text section -->
    <div class="section-header">
      <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z" />
      </svg>
      Text
    </div>

    {#each store.channels.filter((c) => c.kind === "text") as ch (ch.id)}
      <button
        class="channel-row"
        class:active={store.mainView === "chat" && store.activeChannel?.id === ch.id}
        onclick={() => store.selectChannel(ch)}
        oncontextmenu={(e) => onChannelContext(e, ch)}
      >
        <svg class="ch-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path fill="currentColor" fill-rule="evenodd" d="M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z" clip-rule="evenodd" />
        </svg>
        <span class="ch-name">{ch.name}</span>
      </button>
    {/each}

    {#if creating === 'text'}
      <div class="create-row">
        <svg class="ch-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path fill="currentColor" fill-rule="evenodd" d="M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z" clip-rule="evenodd" />
        </svg>
        <input
          class="create-input"
          type="text"
          placeholder="channel-name"
          bind:value={createName}
          use:focus
          onkeydown={(e) => { if (e.key === 'Enter') confirmCreate(); if (e.key === 'Escape') cancelCreate(); }}
          onblur={cancelCreate}
        />
      </div>
    {/if}

    <!-- Voice section -->
    <div class="section-header">
      <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z" />
      </svg>
      Voice
    </div>

    {#each store.channels.filter((c) => c.kind === "voice") as ch (ch.id)}
      <button
        class="channel-row voice-channel"
        class:in-voice={store.voiceChannel?.id === ch.id}
        class:active={store.mainView === "call" && store.voiceChannel?.id === ch.id}
        onclick={() => store.openVoiceChannel(ch)}
        oncontextmenu={(e) => onChannelContext(e, ch)}
      >
        <svg class="ch-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path fill="currentColor" d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z" />
          <path fill="currentColor" d="M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z" />
        </svg>
        <span class="ch-name">{ch.name}</span>
      </button>

      <!-- Participants -->
      {#if store.voiceChannel?.id === ch.id && store.voiceParticipants.length > 0}
        <ul class="participants">
          {#each store.voiceParticipants as p (p.identity)}
            <li class="participant" class:speaking={p.speaking}>
              <div class="participant-avatar" class:speaking={p.speaking}>
                {initial(p.identity)}
              </div>
              <span class="participant-name">{p.identity}</span>
              {#if store.streams.some((s) => s.identity === p.identity)}
                <span class="live-badge">LIVE</span>
              {/if}
              {#if p.muted}
                <span class="status-icon" role="img" aria-label="Muted" use:tooltip={"Muted"}>
                  <VoiceIcon kind="mic" slashed size={16} />
                </span>
              {/if}
              {#if p.deafened}
                <span class="status-icon" role="img" aria-label="Deafened" use:tooltip={"Deafened"}>
                  <VoiceIcon kind="headphones" slashed size={16} />
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/each}

    {#if creating === 'voice'}
      <div class="create-row">
        <svg class="ch-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path fill="currentColor" d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z" />
        </svg>
        <input
          class="create-input"
          type="text"
          placeholder="channel-name"
          bind:value={createName}
          use:focus
          onkeydown={(e) => { if (e.key === 'Enter') confirmCreate(); if (e.key === 'Escape') cancelCreate(); }}
          onblur={cancelCreate}
        />
      </div>
    {/if}
  </nav>

  <!-- Voice connection panel -->
  {#if store.room && store.voiceChannel}
    <div class="voice-panel">
      <div class="voice-status">
        <svg
          class="ping q-{qualityClass(store.voiceQuality)}"
          width="20" height="20" viewBox="0 0 24 24" fill="none"
          role="img"
          aria-label="Connection: {qualityLabel(store.voiceQuality)}"
        >
          <title>Connection: {qualityLabel(store.voiceQuality)}</title>
          <path fill="currentColor" d="M2 3a1 1 0 0 1 1-1 19 19 0 0 1 19 19 1 1 0 1 1-2 0A17 17 0 0 0 3 4a1 1 0 0 1-1-1Z" />
          <path fill="currentColor" d="M2 8a1 1 0 0 1 1-1 14 14 0 0 1 14 14 1 1 0 1 1-2 0A12 12 0 0 0 3 9a1 1 0 0 1-1-1Z" />
          <path fill="currentColor" d="M3 12a1 1 0 1 0 0 2 7 7 0 0 1 7 7 1 1 0 1 0 2 0 9 9 0 0 0-9-9ZM2 17.83c0-.46.37-.83.83-.83C5.13 17 7 18.87 7 21.17c0 .46-.37.83-.83.83H3a1 1 0 0 1-1-1v-3.17Z" />
        </svg>
        <div class="voice-text">
          <span class="voice-label q-{qualityClass(store.voiceQuality)}">Voice Connected</span>
          {#if store.audioBlocked}
            <button class="audio-blocked" onclick={() => store.enableAudio()}>Click to enable audio</button>
          {:else}
            <span class="voice-channel-name">{store.voiceChannel.name}</span>
          {/if}
        </div>
      </div>
      <div class="voice-actions">
        <button
          class="icon-btn"
          class:sharing={store.screenSharing}
          aria-disabled={!store.canScreenShare}
          aria-pressed={store.screenSharing}
          aria-label={store.screenSharing ? "Stop sharing" : "Share your screen"}
          use:tooltip={!store.canScreenShare
            ? "Screen sharing isn't supported in this window"
            : store.screenSharing ? "Stop sharing" : "Share your screen"}
          onclick={shareFromPanel}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path fill="currentColor" fill-rule="evenodd" d="M5 3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h6v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2h6a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H5Zm7 3.5L8.5 10H11v3.5h2V10h2.5L12 6.5Z" />
          </svg>
        </button>
        <button class="icon-btn disconnect" aria-label="Disconnect" use:tooltip={"Disconnect"} onclick={() => store.leaveVoice()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path fill="currentColor" d="M21.33 13.32c-.11 1.03-1.07 1.68-2.07 1.43l-2.73-.68a2.08 2.08 0 0 1-1.57-1.89l-.07-1.3a.63.63 0 0 0-.5-.58 11.58 11.58 0 0 0-4.78 0 .63.63 0 0 0-.5.58l-.07 1.3a2.08 2.08 0 0 1-1.57 1.9l-2.73.67c-1 .25-1.96-.4-2.07-1.43-.2-1.8.23-3.72 2.22-4.9a16.6 16.6 0 0 1 14.82 0c2 1.18 2.43 3.1 2.22 4.9Z" />
          </svg>
        </button>
      </div>
    </div>
  {/if}

  <!-- Footer -->
  <div class="sidebar-footer">
    <div class="avatar">{initial(store.username)}</div>
    <span class="self-name">{store.username}</span>

    {#if store.room}
      <button
        class="icon-btn"
        class:muted={store.voiceMuted}
        aria-label={store.voiceMuted ? "Unmute" : "Mute"}
        aria-pressed={store.voiceMuted}
        use:tooltip={store.micBlocked ? "Microphone unavailable. Check permissions" : store.voiceMuted ? "Unmute" : "Mute"}
        onclick={() => store.toggleMute()}
      >
        <VoiceIcon kind="mic" slashed={store.voiceMuted} />
      </button>

      <button
        class="icon-btn"
        class:muted={store.voiceDeafened}
        aria-label={store.voiceDeafened ? "Undeafen" : "Deafen"}
        aria-pressed={store.voiceDeafened}
        use:tooltip={store.voiceDeafened ? "Undeafen" : "Deafen"}
        onclick={() => store.toggleDeafen()}
      >
        <VoiceIcon kind="headphones" slashed={store.voiceDeafened} />
      </button>
    {/if}
  </div>
</aside>

<!-- Zero-width flex item on the border line, so the grab area can straddle it (the sidebar clips overflow). -->
<div class="resize-rail">
  <!-- A focusable separator is an interactive ARIA widget; Svelte's check treats all separators as static. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="resize-handle"
    class:active={resizing}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={MAX_WIDTH}
    aria-valuenow={width}
    tabindex="0"
    onpointerdown={startResize}
    onkeydown={resizeWithKeys}
  ></div>
</div>

{#if menu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="menu-overlay"
    onclick={closeMenu}
    oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }}
  ></div>
  <div class="context-menu" style="left:{menu.x}px; top:{menu.y}px" role="menu">
    {#each menu.items as item}
      <button
        class="menu-item"
        class:danger={item.danger}
        role="menuitem"
        onclick={() => { item.action(); closeMenu(); }}
      >
        {item.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .sidebar {
    position: relative;
    flex-shrink: 0;
    background: #1e2035;
    border-right: 1px solid #252840;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Resize handle ── */
  .resize-rail {
    position: relative;
    width: 0;
    flex-shrink: 0;
    z-index: 10;
  }

  /* 10px grab area centred on the sidebar's 1px right border, full height. */
  .resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -6px;
    width: 10px;
    cursor: col-resize;
    touch-action: none;
  }

  .resize-handle::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 4px;
    width: 2px;
    background: transparent;
    transition: background 0.15s;
  }

  .resize-handle:hover::after { transition-delay: 0.1s; }
  .resize-handle:hover::after,
  .resize-handle.active::after,
  .resize-handle:focus-visible::after { background: #5b40c2; }
  .resize-handle:focus-visible { outline: none; }

  :global(body.resizing-sidebar) {
    cursor: col-resize;
    user-select: none;
  }

  /* ── Header ── */
  .sidebar-header {
    height: 48px;
    padding: 0 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #252840;
    box-shadow: 0 1px 0 #12132066;
    flex-shrink: 0;
  }

  .sidebar-title {
    font-weight: 700;
    font-size: 15px;
    color: #e8eaf6;
    letter-spacing: -0.01em;
  }

  .icon-btn {
    background: none;
    border: none;
    color: #6b7290;
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    transition: color 0.1s, background 0.1s;
  }

  .icon-btn:hover { color: #d4d8f0; background: #2a2d4a; }
  .icon-btn.muted { color: #e57373; }
  .icon-btn.muted:hover { color: #ef9a9a; }

  /* ── Channel list ── */
  .channels {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 8px;
  }

  /* Discord-style thin bar that only appears while hovering the channel list. */
  .channels::-webkit-scrollbar { width: 8px; }
  .channels::-webkit-scrollbar-thumb {
    border-width: 2px;
    background-color: transparent;
  }
  .channels:hover::-webkit-scrollbar-thumb { background-color: #2e3154; }
  .channels::-webkit-scrollbar-thumb:hover { background-color: #3f4270; }

  .section-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 16px 8px 4px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #6b7290;
    cursor: default;
    user-select: none;
  }

  .chevron { opacity: 0.7; flex-shrink: 0; }

  .channel-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: calc(100% - 8px);
    margin: 1px 4px;
    padding: 6px 8px;
    border: none;
    background: none;
    color: #6b7290;
    font-size: 15px;
    cursor: pointer;
    border-radius: 4px;
    transition: background 0.1s, color 0.1s;
    text-align: left;
  }

  .channel-row:hover { background: #2d3058; color: #c8cde8; }
  .channel-row.active {
    background: #343764;
    color: #e4eaf5;
    font-weight: 600;
    box-shadow: inset 2px 0 0 #7c6dca;
  }
  .channel-row.active .ch-icon { color: #c4b8f8; }
  .channel-row.active:hover { background: #5355a0; }

  .ch-icon {
    flex-shrink: 0;
    color: #4a5168;
    transition: color 0.1s;
  }
  .channel-row:hover .ch-icon { color: #c8cde8; }

  .ch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .voice-channel.in-voice { color: #a78bfa; }
  .voice-channel.in-voice .ch-icon { color: #a78bfa; }

  /* ── Inline create input ── */
  .create-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: calc(100% - 8px);
    margin: 1px 4px;
    padding: 4px 8px;
  }

  .create-row .ch-icon { color: #4a5168; flex-shrink: 0; }

  .create-input {
    flex: 1;
    background: #12132a;
    border: 1px solid #5b40c2;
    border-radius: 3px;
    color: #d4d8f0;
    font-size: 13px;
    padding: 3px 6px;
    outline: none;
    min-width: 0;
  }

  /* ── Participants ── */
  .participants {
    list-style: none;
    margin: 0;
    padding: 2px 0 4px 36px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .participant {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px 2px 0;
    border-radius: 4px;
  }

  .participant-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #3b3f6a;
    color: #a0a8d0;
    font-size: 11px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: box-shadow 0.15s;
  }

  .participant-avatar.speaking { box-shadow: 0 0 0 2px #4ade80; }

  .participant-name {
    font-size: 13px;
    color: #6b7290;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 0.15s;
  }

  .participant.speaking .participant-name { color: #c8cde8; }

  .live-badge {
    flex-shrink: 0;
    padding: 0 4px;
    border-radius: 3px;
    background: #d83c3e;
    color: #fff;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.04em;
    line-height: 16px;
  }

  .status-icon {
    display: flex;
    flex-shrink: 0;
    color: #8a90b4;
  }

  /* ── Voice connection panel ── */
  .voice-panel {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 10px;
    background: #191b2e;
    border-top: 1px solid #252840;
    flex-shrink: 0;
  }

  .voice-status {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ping { flex-shrink: 0; }
  .q-good { color: #4ade80; }
  .q-poor { color: #facc15; }
  .q-lost { color: #f87171; }

  .voice-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }

  .voice-label {
    font-size: 13px;
    font-weight: 600;
  }

  .voice-channel-name {
    font-size: 12px;
    color: #8a90b4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .audio-blocked {
    padding: 0;
    border: none;
    background: none;
    color: #facc15;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .audio-blocked:hover { text-decoration: underline; }

  .voice-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }

  .icon-btn.sharing { color: #fff; background: #5b40c2; }
  .icon-btn.sharing:hover { background: #6d50d6; }
  .icon-btn[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
  .icon-btn[aria-disabled="true"]:hover { color: #6b7290; background: none; }

  .icon-btn.disconnect,
  .icon-btn.disconnect:hover { color: #c8cde8; }

  /* ── Footer ── */
  .sidebar-footer {
    height: 52px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: #191b2e;
    border-top: 1px solid #252840;
    flex-shrink: 0;
  }

  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #5b40c2;
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    user-select: none;
  }

  .self-name {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
    color: #d4d8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  /* ── Context menu ── */
  .menu-overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .context-menu {
    position: fixed;
    z-index: 100;
    background: #1a1c30;
    border: 1px solid #2e3154;
    border-radius: 6px;
    padding: 4px;
    min-width: 192px;
    box-shadow: 0 8px 24px #00000066;
  }

  .menu-item {
    display: block;
    width: 100%;
    padding: 7px 10px;
    background: none;
    border: none;
    border-radius: 4px;
    color: #b8bcdc;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }

  .menu-item:hover { background: #5b40c2; color: #fff; }
  .menu-item.danger { color: #f87171; }
  .menu-item.danger:hover { background: #7f1d1d; color: #fca5a5; }
</style>
