<script lang="ts">
  import { store } from "$lib/store.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import VoiceIcon from "$lib/components/VoiceIcon.svelte";

  const count = $derived(store.voiceParticipants.length);
  const cols = $derived(count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4);
  const rows = $derived(Math.max(1, Math.ceil(count / cols)));

  // Stable per-user colour so tiles are tellable apart before there's video.
  function hue(name: string) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
    return h;
  }
</script>

<div class="call">
  <header class="call-header">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z" />
      <path fill="currentColor" d="M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z" />
    </svg>
    <span>{store.voiceChannel?.name}</span>
  </header>

  <div class="stage">
    <div class="grid" style="--cols: {cols}; --rows: {rows}">
      {#each store.voiceParticipants as p (p.identity)}
        <div class="tile" class:speaking={p.speaking} style="--hue: {hue(p.identity)}">
          <!-- Video will render here; the avatar is the no-video fallback. -->
          <div class="tile-media">
            <div class="tile-avatar">{p.identity.charAt(0).toUpperCase()}</div>
          </div>
          <div class="tile-label">
            <span class="tile-name">{p.identity}</span>
            {#if p.muted}
              <span class="tile-icon" role="img" aria-label="Muted"><VoiceIcon kind="mic" slashed size={16} /></span>
            {/if}
            {#if p.deafened}
              <span class="tile-icon" role="img" aria-label="Deafened"><VoiceIcon kind="headphones" slashed size={16} /></span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="controls">
    <button class="ctrl" aria-disabled="true" aria-label="Turn on camera" use:tooltip={"Camera is coming soon"}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path fill="currentColor" d="M4 5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1.38l3.55 1.77A1 1 0 0 0 22 15.5v-7a1 1 0 0 0-1.45-.9L17 9.39V8a3 3 0 0 0-3-3H4Z" />
      </svg>
    </button>
    <button class="ctrl" aria-disabled="true" aria-label="Share your screen" use:tooltip={"Screen share is coming soon"}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path fill="currentColor" fill-rule="evenodd" d="M5 3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h6v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2h6a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H5Zm7 3.5L8.5 10H11v3.5h2V10h2.5L12 6.5Z" />
      </svg>
    </button>

    <span class="divider" aria-hidden="true"></span>

    <button
      class="ctrl"
      class:off={store.voiceMuted}
      aria-label={store.voiceMuted ? "Unmute" : "Mute"}
      aria-pressed={store.voiceMuted}
      use:tooltip={store.micBlocked ? "Microphone unavailable. Check permissions" : store.voiceMuted ? "Unmute" : "Mute"}
      onclick={() => store.toggleMute()}
    >
      <VoiceIcon kind="mic" slashed={store.voiceMuted} size={24} />
    </button>
    <button
      class="ctrl"
      class:off={store.voiceDeafened}
      aria-label={store.voiceDeafened ? "Undeafen" : "Deafen"}
      aria-pressed={store.voiceDeafened}
      use:tooltip={store.voiceDeafened ? "Undeafen" : "Deafen"}
      onclick={() => store.toggleDeafen()}
    >
      <VoiceIcon kind="headphones" slashed={store.voiceDeafened} size={24} />
    </button>
    <button class="ctrl hangup" aria-label="Disconnect" use:tooltip={"Disconnect"} onclick={() => store.leaveVoice()}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path fill="currentColor" d="M21.33 13.32c-.11 1.03-1.07 1.68-2.07 1.43l-2.73-.68a2.08 2.08 0 0 1-1.57-1.89l-.07-1.3a.63.63 0 0 0-.5-.58 11.58 11.58 0 0 0-4.78 0 .63.63 0 0 0-.5.58l-.07 1.3a2.08 2.08 0 0 1-1.57 1.9l-2.73.67c-1 .25-1.96-.4-2.07-1.43-.2-1.8.23-3.72 2.22-4.9a16.6 16.6 0 0 1 14.82 0c2 1.18 2.43 3.1 2.22 4.9Z" />
      </svg>
    </button>
  </div>
</div>

<style>
  .call {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #12131f;
  }

  .call-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid #2a2d4a;
    color: #e8eaf6;
    font-weight: 600;
    font-size: 15px;
    flex-shrink: 0;
  }

  .call-header svg {
    color: #8a90b4;
  }

  /* ── Tile grid: sized so every row fits the stage height at 16:9 ── */
  .stage {
    flex: 1;
    min-height: 0;
    padding: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    container-type: size;
    overflow: hidden;
  }

  .grid {
    --gap: 8px;
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    gap: var(--gap);
    width: min(
      100%,
      calc((100cqh - (var(--rows) - 1) * var(--gap)) / var(--rows) * 16 / 9 * var(--cols) + (var(--cols) - 1) * var(--gap))
    );
  }

  .tile {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: 8px;
    overflow: hidden;
    background: hsl(var(--hue) 28% 22%);
    container-type: size;
  }

  /* Speaking ring as an overlay, so it stays visible once video covers the tile. */
  .tile::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 3px #4ade80;
    opacity: 0;
    transition: opacity 0.1s;
    pointer-events: none;
  }

  .tile.speaking::after {
    opacity: 1;
  }

  .tile-media {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tile-avatar {
    width: clamp(48px, 32cqh, 120px);
    aspect-ratio: 1;
    border-radius: 50%;
    background: hsl(var(--hue) 45% 45%);
    color: #fff;
    font-size: clamp(20px, 13cqh, 48px);
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
  }

  .tile-label {
    position: absolute;
    left: 8px;
    bottom: 8px;
    max-width: calc(100% - 16px);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 4px;
    background: #0009;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
  }

  .tile-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tile-icon {
    display: flex;
    flex-shrink: 0;
    color: #f87171;
  }

  /* ── Controls ── */
  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 12px 16px 20px;
    flex-shrink: 0;
  }

  .ctrl {
    width: 52px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 50%;
    background: #2b2e4a;
    color: #e4e6f5;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  .ctrl:hover {
    background: #363a5e;
  }

  .ctrl.off {
    background: #f2f3f5;
    color: #d83c3e;
  }

  .ctrl.off:hover {
    background: #dcdde3;
  }

  .ctrl[aria-disabled="true"] {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .ctrl[aria-disabled="true"]:hover {
    background: #2b2e4a;
  }

  .ctrl.hangup {
    width: 64px;
    border-radius: 26px;
    background: #d83c3e;
    color: #fff;
  }

  .ctrl.hangup:hover {
    background: #a12d2f;
  }

  .divider {
    width: 1px;
    height: 32px;
    background: #33365a;
  }
</style>
