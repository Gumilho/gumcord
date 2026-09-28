<script lang="ts">
  import { store } from "$lib/store.svelte.ts";

  type MenuItem = { label: string; action: () => void; danger?: boolean };
  type MenuState = { x: number; y: number; items: MenuItem[] };
  type Channel = { id: number; name: string; kind: string };

  function initial(name: string) { return name.charAt(0).toUpperCase(); }

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
      openMenu(e, [
        store.room
          ? { label: 'Leave Channel', action: () => store.leaveVoice(), danger: true }
          : { label: 'Join Channel', action: () => store.joinVoice(ch) },
      ]);
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

<aside class="sidebar">
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
        class:active={store.activeChannel?.id === ch.id}
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
        class:in-voice={!!store.room}
        onclick={() => (store.room ? store.leaveVoice() : store.joinVoice(ch))}
        oncontextmenu={(e) => onChannelContext(e, ch)}
      >
        <svg class="ch-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path fill="currentColor" d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z" />
          <path fill="currentColor" d="M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z" />
        </svg>
        <span class="ch-name">{ch.name}</span>
        {#if store.room}
          <span class="leave-badge">Leave</span>
        {/if}
      </button>

      <!-- Participants -->
      {#if store.room && store.voiceParticipants.length > 0}
        <ul class="participants">
          {#each store.voiceParticipants as p (p.identity)}
            <li class="participant" class:speaking={p.speaking}>
              <div class="participant-avatar" class:speaking={p.speaking}>
                {initial(p.identity)}
              </div>
              <span class="participant-name">{p.identity}</span>
              <svg
                class="mic-status"
                class:muted={p.identity === store.username && store.voiceMuted}
                width="14" height="14" viewBox="0 0 24 24" fill="none"
              >
                <path fill="currentColor" d="M14.5 2.1a2.5 2.5 0 0 0-5 0v9.8a2.5 2.5 0 0 0 5 0V2.1ZM19 10a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.07A7 7 0 0 0 19 10Z" />
              </svg>
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

  <!-- Footer -->
  <div class="sidebar-footer">
    <div class="avatar">{initial(store.username)}</div>
    <span class="self-name">{store.username}</span>

    {#if store.room}
      <button
        class="icon-btn"
        class:muted={store.voiceMuted}
        title={store.voiceMuted ? "Unmute" : "Mute"}
        onclick={() => store.toggleMute()}
      >
        {#if store.voiceMuted}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path fill="currentColor" d="M2.7 3.7a1 1 0 1 1 1.42-1.42l16 16a1 1 0 0 1-1.42 1.42l-1.68-1.67A7 7 0 0 1 11 24.93V22H9a1 1 0 1 1 0-2h2v-2.07A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 0 0 7.41 4.38L12 13l-.59-.59A2.5 2.5 0 0 1 7 11V5.41L2.7 3.7ZM17 11a1 1 0 1 1 2 0 7 7 0 0 1-.36 2.24l-1.52-1.52A5 5 0 0 0 17 11Zm-5-9a2.5 2.5 0 0 1 2.5 2.5v5.09l-5-5V4.1A2.5 2.5 0 0 1 12 2Z" />
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path fill="currentColor" d="M14.5 2.1a2.5 2.5 0 0 0-5 0v9.8a2.5 2.5 0 0 0 5 0V2.1ZM19 10a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.07A7 7 0 0 0 19 10Z" />
          </svg>
        {/if}
      </button>
    {/if}
  </div>
</aside>

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
    width: 232px;
    flex-shrink: 0;
    background: #1e2035;
    border-right: 1px solid #252840;
    display: flex;
    flex-direction: column;
    overflow: hidden;
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

  .leave-badge {
    font-size: 10px;
    font-weight: 600;
    color: #f87171;
    background: #2d1515;
    border-radius: 3px;
    padding: 1px 5px;
    margin-left: auto;
    flex-shrink: 0;
  }

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

  .mic-status { color: #4a5168; flex-shrink: 0; }
  .mic-status.muted { color: #f87171; }

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
