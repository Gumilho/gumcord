<script lang="ts">
  import type { Track } from "livekit-client";
  import { store, type ScreenStream } from "$lib/store.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import VoiceIcon from "$lib/components/VoiceIcon.svelte";

  const count = $derived(store.voiceParticipants.length + store.streams.length);
  const cols = $derived(count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4);
  const rows = $derived(Math.max(1, Math.ceil(count / cols)));

  // Focused screen share: fills the stage, everyone else moves to a strip underneath.
  let focusedId: string | null = $state(null);
  const focused = $derived(store.streams.find((s) => s.identity === focusedId) ?? null);
  const others = $derived(store.streams.filter((s) => s !== focused));

  // Drop focus when the stream ends or is no longer being watched.
  $effect(() => {
    if (focusedId && (!focused || (!focused.track && !focused.loading))) focusedId = null;
  });

  function toggleFocus(s: ScreenStream) {
    focusedId = focusedId === s.identity ? null : s.identity;
  }

  // Opting in to a stream also puts it front and centre, like Discord.
  function watch(s: ScreenStream) {
    store.watchStream(s.identity);
    focusedId = s.identity;
  }

  function stopWatching(s: ScreenStream) {
    if (document.fullscreenElement) void document.exitFullscreen();
    store.stopWatching(s.identity);
  }

  function attachVideo(node: HTMLVideoElement, track: Track) {
    let current = track;
    current.attach(node);
    return {
      // Svelte re-runs this for every object it's given; only re-attach when the track really changed.
      update(next: Track) {
        if (next === current) return;
        current.detach(node);
        current = next;
        current.attach(node);
      },
      destroy() {
        current.detach(node);
      },
    };
  }

  function toggleFullscreen(e: MouseEvent) {
    const tile = (e.currentTarget as HTMLElement).closest(".tile");
    if (document.fullscreenElement) void document.exitFullscreen();
    else void tile?.requestFullscreen().catch(() => {});
  }

  function streamLabel(s: ScreenStream) {
    return s.local ? "Your screen" : `${s.identity}'s screen`;
  }

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

  {#snippet personTile(p: (typeof store.voiceParticipants)[number])}
    <div class="tile" class:speaking={p.speaking} style="--hue: {hue(p.identity)}">
      <!-- Camera video will render here; the avatar is the no-video fallback. -->
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
  {/snippet}

  {#snippet streamTile(s: ScreenStream, spotlight: boolean)}
    <div class="tile stream" class:spotlight style="--hue: {hue(s.identity)}">
      {#if s.track}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="tile-video" use:attachVideo={s.track} autoplay playsinline muted></video>
        <button
          class="tile-hit"
          aria-label={spotlight ? `Stop focusing ${streamLabel(s)}` : `Focus ${streamLabel(s)}`}
          onclick={() => toggleFocus(s)}
        ></button>
        <div class="tile-actions">
          {#if !s.local}
            <button class="tile-action" aria-label="Stop watching" use:tooltip={"Stop watching"} onclick={() => stopWatching(s)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path fill="currentColor" d="M2.3 2.3a1 1 0 0 1 1.4 0l18 18a1 1 0 0 1-1.4 1.4l-3.04-3.04A11.6 11.6 0 0 1 12 20C6.5 20 2.84 15.9 1.4 13.34a2.7 2.7 0 0 1 0-2.68 16.4 16.4 0 0 1 3.8-4.57L2.3 3.7a1 1 0 0 1 0-1.4Zm6.07 7.48a4 4 0 0 0 5.85 5.85l-1.5-1.5a2 2 0 0 1-2.85-2.85l-1.5-1.5ZM12 4c5.5 0 9.16 4.1 10.6 6.66.47.84.47 1.84 0 2.68a15.9 15.9 0 0 1-2.36 3.2l-3.3-3.3A4 4 0 0 0 11.77 8L8.66 4.9A11.2 11.2 0 0 1 12 4Z" />
              </svg>
            </button>
          {/if}
          <button class="tile-action" aria-label="Fullscreen" use:tooltip={"Fullscreen"} onclick={toggleFullscreen}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path fill="currentColor" d="M4 4a1 1 0 0 1 1-1h4a1 1 0 0 1 0 2H6v3a1 1 0 0 1-2 0V4Zm11-1a1 1 0 1 0 0 2h3v3a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-4ZM5 15a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Zm15 1a1 1 0 1 0-2 0v3h-3a1 1 0 1 0 0 2h4a1 1 0 0 0 1-1v-4Z" />
            </svg>
          </button>
        </div>
      {:else}
        <div class="stream-invite">
          <span class="stream-invite-text">{s.identity} is live</span>
          <button class="watch-btn" disabled={s.loading} onclick={() => watch(s)}>
            {s.loading ? "Loading…" : "Watch Stream"}
          </button>
        </div>
      {/if}
      <div class="tile-label">
        <span class="live">LIVE</span>
        <span class="tile-name">{streamLabel(s)}</span>
      </div>
    </div>
  {/snippet}

  <div class="stage" class:focus={!!focused}>
    {#if focused}
      <div class="spotlight-area">
        {@render streamTile(focused, true)}
      </div>
      <div class="strip">
        {#each others as s (s.identity)}
          {@render streamTile(s, false)}
        {/each}
        {#each store.voiceParticipants as p (p.identity)}
          {@render personTile(p)}
        {/each}
      </div>
    {:else}
      <div class="grid" style="--cols: {cols}; --rows: {rows}">
        {#each store.streams as s (s.identity)}
          {@render streamTile(s, false)}
        {/each}
        {#each store.voiceParticipants as p (p.identity)}
          {@render personTile(p)}
        {/each}
      </div>
    {/if}
  </div>

  <div class="controls">
    <button class="ctrl" aria-disabled="true" aria-label="Turn on camera" use:tooltip={"Camera is coming soon"}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path fill="currentColor" d="M4 5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1.38l3.55 1.77A1 1 0 0 0 22 15.5v-7a1 1 0 0 0-1.45-.9L17 9.39V8a3 3 0 0 0-3-3H4Z" />
      </svg>
    </button>
    <button
      class="ctrl"
      class:sharing={store.screenSharing}
      aria-disabled={!store.canScreenShare}
      aria-pressed={store.screenSharing}
      aria-label={store.screenSharing ? "Stop sharing" : "Share your screen"}
      use:tooltip={!store.canScreenShare
        ? "Screen sharing isn't supported in this window"
        : store.screenSharing ? "Stop sharing" : "Share your screen"}
      onclick={() => store.toggleScreenShare()}
    >
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

  /* ── Focus layout: spotlighted stream on top, everything else in a strip ── */
  .stage.focus {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }

  .spotlight-area {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .strip {
    flex-shrink: 0;
    height: 112px;
    display: flex;
    gap: 8px;
    justify-content: center;
    justify-content: safe center;
    overflow-x: auto;
  }

  .strip .tile {
    height: 100%;
    flex-shrink: 0;
  }

  /* ── Screen share tiles ── */
  .tile.stream {
    background: #000;
  }

  .tile.spotlight {
    aspect-ratio: auto;
    width: 100%;
    height: 100%;
  }

  .tile:fullscreen {
    border-radius: 0;
  }

  .tile-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .tile-hit {
    position: absolute;
    inset: 0;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }

  .tile.spotlight .tile-hit {
    cursor: zoom-out;
  }

  .live {
    padding: 1px 5px;
    border-radius: 3px;
    background: #d83c3e;
    color: #fff;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.04em;
  }

  .tile-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 6px;
    opacity: 0;
    transition: opacity 0.12s;
  }

  .tile:hover .tile-actions,
  .tile-actions:focus-within {
    opacity: 1;
  }

  .tile-action {
    display: flex;
    padding: 6px;
    border: none;
    border-radius: 6px;
    background: #0009;
    color: #fff;
    cursor: pointer;
  }

  .tile-action:hover {
    background: #000c;
  }

  /* Unwatched stream: an invitation instead of video. */
  .stream-invite {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: clamp(6px, 5cqh, 14px);
    background: linear-gradient(160deg, hsl(var(--hue) 30% 20%), #0d0e18);
  }

  .stream-invite-text {
    max-width: 90%;
    color: #e4e6f5;
    font-size: clamp(12px, 7cqh, 18px);
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .watch-btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    background: #f2f3f5;
    color: #1a1b2e;
    font: inherit;
    font-size: clamp(12px, 6cqh, 14px);
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
  }

  .watch-btn:hover:not(:disabled) {
    background: #fff;
  }

  .watch-btn:disabled {
    opacity: 0.7;
    cursor: progress;
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
    pointer-events: none;
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

  .ctrl.sharing {
    background: #5b40c2;
    color: #fff;
  }

  .ctrl.sharing:hover {
    background: #6d50d6;
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
