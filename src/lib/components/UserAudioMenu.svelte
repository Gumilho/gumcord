<script lang="ts">
  import { store } from "$lib/store.svelte.ts";

  // Per-person volume and mute for someone's voice, or for their screen-share audio when opened on a stream.
  const MENU_W = 232;
  const MENU_H = 150;

  const menu = $derived(store.userMenu);
  const stream = $derived(menu?.kind === "stream");
  const audio = $derived.by(() => {
    if (!menu) return null;
    const a = store.userAudioFor(menu.identity);
    return stream ? { volume: a.streamVolume, muted: a.streamMuted } : { volume: a.volume, muted: a.muted };
  });
  const percent = $derived(audio ? Math.round(audio.volume * 100) : 100);
  // Keep the whole menu on screen.
  const pos = $derived(menu && {
    x: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
    y: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_H - 8)),
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") store.closeUserMenu(); }} />

{#if menu && audio && pos}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="overlay"
    onclick={() => store.closeUserMenu()}
    oncontextmenu={(e) => { e.preventDefault(); store.closeUserMenu(); }}
  ></div>
  <div class="menu" role="menu" aria-label="{stream ? 'Stream' : 'Voice'} settings for {menu.name}" style="left:{pos.x}px; top:{pos.y}px; width:{MENU_W}px">
    <div class="name">{menu.name}</div>

    <div class="volume">
      <div class="volume-head">
        <span>{stream ? "Stream Volume" : "User Volume"}</span>
        <span class="value">
          {#if percent !== 100}
            <button class="reset" type="button" onclick={() => store.setUserVolume(menu.identity, 1, menu.kind)}>Reset</button>
          {/if}
          {percent}%
        </span>
      </div>
      <input
        type="range"
        min="0"
        max="200"
        step="1"
        value={percent}
        disabled={audio.muted}
        aria-label="{stream ? 'Stream volume' : 'Volume'} for {menu.name}"
        style="--fill: {percent / 2}%"
        oninput={(e) => store.setUserVolume(menu.identity, Number(e.currentTarget.value) / 100, menu.kind)}
      />
    </div>

    <div class="divider"></div>

    <button
      class="item"
      type="button"
      role="menuitemcheckbox"
      aria-checked={audio.muted}
      onclick={() => store.toggleUserMute(menu.identity, menu.kind)}
    >
      <span>{stream ? "Mute Stream" : "Mute"}</span>
      <span class="check" class:on={audio.muted} aria-hidden="true">
        {#if audio.muted}
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        {/if}
      </span>
    </button>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .menu {
    position: fixed;
    z-index: 100;
    padding: 6px;
    border: 1px solid #2e3154;
    border-radius: 6px;
    background: #1a1c30;
    box-shadow: 0 8px 24px #00000066;
    color: #b8bcdc;
    font-size: 13px;
  }

  .name {
    padding: 4px 8px 6px;
    color: #e4e6f5;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .volume {
    padding: 4px 8px 8px;
  }

  .volume-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .value {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #e4e6f5;
    font-variant-numeric: tabular-nums;
  }

  .reset {
    padding: 0;
    border: none;
    background: none;
    color: #a78bfa;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .reset:hover { text-decoration: underline; }

  input[type="range"] {
    display: block;
    width: 100%;
    height: 6px;
    margin: 0;
    border-radius: 3px;
    background: linear-gradient(to right, #5b40c2 var(--fill), #33365a var(--fill));
    appearance: none;
    cursor: pointer;
  }

  input[type="range"]:disabled {
    opacity: 0.4;
    cursor: default;
  }

  input[type="range"]::-webkit-slider-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 4px #0008;
    appearance: none;
  }

  input[type="range"]::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: none;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 4px #0008;
  }

  .divider {
    height: 1px;
    margin: 2px 4px 4px;
    background: #2e3154;
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 7px 8px;
    border: none;
    border-radius: 4px;
    background: none;
    color: #b8bcdc;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }

  .item:hover { background: #5b40c2; color: #fff; }

  .check {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 1.5px solid #6b7290;
    border-radius: 4px;
    color: #fff;
  }

  .check.on {
    border-color: #5b40c2;
    background: #5b40c2;
  }

  .item:hover .check { border-color: #fff; }
</style>
