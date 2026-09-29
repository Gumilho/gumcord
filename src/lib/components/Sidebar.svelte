<script lang="ts">
  import { store, type Channel, type ChannelKind } from "$lib/store.svelte.ts";
  import { ConnectionQuality } from "livekit-client";
  import { tooltip } from "$lib/tooltip.ts";
  import UserAvatar from "$lib/components/UserAvatar.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import VoiceIcon from "$lib/components/VoiceIcon.svelte";
  import ServerSettings from "$lib/components/ServerSettings.svelte";
  import UserSettings from "$lib/components/UserSettings.svelte";
  import Soundboard from "$lib/components/Soundboard.svelte";

  let soundboardBtn: HTMLButtonElement | null = $state(null);
  let soundboardOpen = $state(false);

  type MenuItem = { label: string; action: () => void; danger?: boolean };
  type MenuState = { x: number; y: number; items: MenuItem[] };

  const QUALITY_LABEL: Record<ConnectionQuality, string> = {
    [ConnectionQuality.Excellent]: "excellent",
    [ConnectionQuality.Good]: "good",
    [ConnectionQuality.Poor]: "poor",
    [ConnectionQuality.Lost]: "lost",
    [ConnectionQuality.Unknown]: "checking…",
  };

  const quality = $derived({
    cls: store.voiceQuality === ConnectionQuality.Poor ? "poor" : store.voiceQuality === ConnectionQuality.Lost ? "lost" : "good",
    label: QUALITY_LABEL[store.voiceQuality],
  });

  const textChannels = $derived(store.channels.filter((c) => c.kind === "text"));
  const voiceChannels = $derived(store.channels.filter((c) => c.kind === "voice"));
  const liveIds = $derived(new Set(store.streams.map((s) => s.identity)));

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
  let settingsOpen = $state(false);
  let userSettingsOpen = $state(false);
  let creating: ChannelKind | null = $state(null);
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

  // Admins create channels; everyone else gets the browser's own menu.
  function onNavContext(e: MouseEvent) {
    if (!store.me?.admin || !store.activeServer) return;
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

  function startCreate(kind: ChannelKind) {
    creating = kind;
    createName = '';
  }

  async function confirmCreate() {
    const name = createName.trim();
    if (!name || !creating) return;
    await store.createChannel(name, creating);
    cancelCreate();
  }

  function cancelCreate() {
    creating = null;
    createName = '';
  }
</script>

<svelte:window
  onkeydown={(e) => { if (e.key === 'Escape') { closeMenu(); cancelCreate(); } }}
/>

{#snippet createRow(kind: ChannelKind)}
  <div class="create-row">
    <span class="ch-icon"><Icon name={kind === "text" ? "hash" : "speaker"} size={18} /></span>
    <input
      class="create-input"
      type="text"
      placeholder="channel-name"
      bind:value={createName}
      use:focus
      onkeydown={(e) => { if (e.key === 'Enter') confirmCreate(); }}
      onblur={cancelCreate}
    />
  </div>
{/snippet}

<aside class="sidebar" style="width: {width}px">
  <!-- Header -->
  <div class="sidebar-header">
    <span class="sidebar-title">{store.activeServer?.name ?? "Gumcord"}</span>
    <div class="header-actions">
      {#if store.me?.admin && store.activeServer}
        <button class="icon-btn" aria-label="Server settings" use:tooltip={"Server settings"} onclick={() => (settingsOpen = true)}>
          <Icon name="settings" size={18} />
        </button>
      {/if}
      <button class="icon-btn" aria-label="Log out" use:tooltip={"Log out"} onclick={() => store.logout()}>
        <Icon name="logout" size={18} />
      </button>
    </div>
  </div>

  <!-- Channels list -->
  <nav class="channels" oncontextmenu={onNavContext}>
    <!-- Text section -->
    <div class="section-header">
      <span class="chevron"><Icon name="chevron" size={12} /></span>
      Text
    </div>

    {#each textChannels as ch (ch.id)}
      <button
        class="channel-row"
        class:active={store.mainView === "chat" && store.activeChannel?.id === ch.id}
        onclick={() => store.selectChannel(ch)}
        oncontextmenu={(e) => onChannelContext(e, ch)}
      >
        <span class="ch-icon"><Icon name="hash" size={18} /></span>
        <span class="ch-name">{ch.name}</span>
      </button>
    {/each}

    {#if creating === 'text'}
      {@render createRow('text')}
    {/if}

    <!-- Voice section -->
    <div class="section-header">
      <span class="chevron"><Icon name="chevron" size={12} /></span>
      Voice
    </div>

    {#each voiceChannels as ch (ch.id)}
      <button
        class="channel-row voice-channel"
        class:in-voice={store.voiceChannel?.id === ch.id}
        class:active={store.mainView === "call" && store.voiceChannel?.id === ch.id}
        onclick={() => store.openVoiceChannel(ch)}
        oncontextmenu={(e) => onChannelContext(e, ch)}
      >
        <span class="ch-icon"><Icon name="speaker" size={18} /></span>
        <span class="ch-name">{ch.name}</span>
      </button>

      <!-- Participants -->
      <!-- Your own call uses live LiveKit state; other channels use what the server reports. -->
      {@const inCall = store.voiceChannel?.id === ch.id}
      {@const members = inCall ? store.voiceParticipants : (store.voiceRooms.get(ch.id) ?? [])}
      {#if members.length > 0}
        <ul class="participants">
          {#each members as p (p.identity)}
            {@const speaking = inCall && store.speaking.has(p.identity)}
            {@const live = inCall ? liveIds.has(p.identity) : "streaming" in p && p.streaming}
            {@const mutedByMe = store.userAudioFor(p.identity).muted}
            {@const clickable = !store.isMe(p.identity)}
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <li
              class="participant"
              class:speaking
              class:clickable
              role={clickable ? "button" : undefined}
              tabindex={clickable ? 0 : undefined}
              aria-label={clickable ? `Voice settings for ${p.name}` : undefined}
              onclick={(e) => store.openUserMenu(e, p)}
              oncontextmenu={(e) => store.openUserMenu(e, p)}
              onkeydown={(e) => store.openUserMenu(e, p)}
            >
              <div class="participant-avatar" class:speaking>
                <UserAvatar name={p.name} src={p.avatar} />
              </div>
              <span class="participant-name">{p.name}</span>
              {#if live}
                <span class="live-badge">LIVE</span>
              {/if}
              {#if mutedByMe}
                <span class="status-icon muted-by-me" role="img" aria-label="Muted for you" use:tooltip={"Muted for you"}>
                  <VoiceIcon kind="mic" slashed size={16} />
                </span>
              {:else if p.muted}
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
      {@render createRow('voice')}
    {/if}
  </nav>

  <!-- Voice connection panel -->
  {#if store.room && store.voiceChannel}
    <div class="voice-panel">
      <div class="voice-status q-{quality.cls}">
        <span class="ping" role="img" aria-label="Connection: {quality.label}" use:tooltip={`Connection: ${quality.label}`}>
          <Icon name="signal" />
        </span>
        <div class="voice-text">
          <span class="voice-label">Voice Connected</span>
          {#if store.audioBlocked}
            <button class="audio-blocked" onclick={() => store.enableAudio()}>Click to enable audio</button>
          {:else}
            <!-- Names the server too: you may be looking at a different one. -->
            <span class="voice-channel-name">{store.voiceChannel.name}{store.voiceServer ? ` / ${store.voiceServer.name}` : ""}</span>
          {/if}
        </div>
      </div>
      <div class="voice-actions">
        <button
          class="icon-btn"
          class:sharing={store.screenSharing}
          aria-disabled={!store.canScreenShare}
          aria-pressed={store.screenSharing}
          aria-label={store.shareLabel}
          use:tooltip={store.shareLabel}
          onclick={() => store.toggleScreenShare()}
        >
          <Icon name="screenShare" />
        </button>
        <button
          class="icon-btn"
          aria-label="Soundboard"
          aria-expanded={soundboardOpen}
          use:tooltip={"Soundboard"}
          bind:this={soundboardBtn}
          onclick={() => (soundboardOpen = !soundboardOpen)}
        >
          <Icon name="soundboard" />
        </button>
        {#if soundboardOpen && soundboardBtn}
          <Soundboard anchor={soundboardBtn} onclose={() => (soundboardOpen = false)} />
        {/if}
        <button class="icon-btn disconnect" aria-label="Disconnect" use:tooltip={"Disconnect"} onclick={() => store.leaveVoice()}>
          <Icon name="hangup" />
        </button>
      </div>
    </div>
  {/if}

  <!-- Footer -->
  <div class="sidebar-footer">
    <div class="avatar"><UserAvatar name={store.me?.name ?? ""} src={store.me?.avatar} /></div>
    <span class="self-name">{store.me?.name}</span>

    {#if store.room}
      <button
        class="icon-btn"
        class:muted={store.voiceMuted}
        aria-label={store.muteLabel}
        aria-pressed={store.voiceMuted}
        use:tooltip={store.muteLabel}
        onclick={() => store.toggleMute()}
      >
        <VoiceIcon kind="mic" slashed={store.voiceMuted} />
      </button>

      <button
        class="icon-btn"
        class:muted={store.voiceDeafened}
        aria-label={store.deafenLabel}
        aria-pressed={store.voiceDeafened}
        use:tooltip={store.deafenLabel}
        onclick={() => store.toggleDeafen()}
      >
        <VoiceIcon kind="headphones" slashed={store.voiceDeafened} />
      </button>
    {/if}

    <button class="icon-btn" aria-label="User settings" use:tooltip={"User settings"} onclick={() => (userSettingsOpen = true)}>
      <Icon name="settings" />
    </button>
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

{#if userSettingsOpen}
  <UserSettings onclose={() => (userSettingsOpen = false)} />
{/if}

{#if settingsOpen && store.activeServer}
  <ServerSettings server={store.activeServer} onclose={() => (settingsOpen = false)} />
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
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-weight: 700;
    font-size: 15px;
    color: #e8eaf6;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
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

  .chevron { display: flex; opacity: 0.7; flex-shrink: 0; }

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
    display: flex;
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
    padding: 2px 0 4px 30px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .participant {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px 2px 6px;
    border-radius: 4px;
  }

  .participant.clickable {
    cursor: pointer;
    transition: background 0.1s;
  }

  .participant.clickable:hover,
  .participant.clickable:focus-visible { background: #2d3058; }

  .participant.clickable:focus-visible { outline: 2px solid #7c5cbf; outline-offset: -2px; }

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

  .status-icon.muted-by-me { color: #f87171; }

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

  .ping { display: flex; flex-shrink: 0; }
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
