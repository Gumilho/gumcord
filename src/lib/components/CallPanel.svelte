<script lang="ts">
  import type { Track } from "livekit-client";
  import { store, type ScreenStream, type VoiceParticipant } from "$lib/store.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import { hue } from "$lib/avatar.ts";
  import UserAvatar from "$lib/components/UserAvatar.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import VoiceIcon from "$lib/components/VoiceIcon.svelte";
  import MemberList from "$lib/components/MemberList.svelte";
  import MemberListToggle from "$lib/components/MemberListToggle.svelte";
  import Soundboard from "$lib/components/Soundboard.svelte";
  import { t } from "$lib/i18n.svelte.ts";

  let soundboardBtn: HTMLButtonElement | null = $state(null);
  let soundboardOpen = $state(false);

  const count = $derived(store.voiceParticipants.length + store.streams.length);
  const cols = $derived(count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4);
  const rows = $derived(Math.max(1, Math.ceil(count / cols)));

  // Focused screen share: fills the stage, everyone else moves to a strip underneath.
  // A stream that ended or is no longer being watched simply stops matching.
  let focusedId: string | null = $state(null);
  const focused = $derived(
    store.streams.find((s) => s.identity === focusedId && (s.track || s.loading)) ?? null,
  );
  const tiledStreams = $derived(focused ? store.streams.filter((s) => s !== focused) : store.streams);

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
    return s.local ? t("Your screen") : t("{name}'s screen", { name: s.name });
  }
</script>

<div class="call">
  <header class="call-header">
    <span class="header-icon"><Icon name="speaker" /></span>
    <span class="header-title">{store.voiceChannel?.name}</span>
    <MemberListToggle />
  </header>

  {#snippet personTile(p: VoiceParticipant)}
    {@const clickable = !store.isMe(p.identity)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="tile"
      class:speaking={store.speaking.has(p.identity)}
      class:clickable
      style="--hue: {hue(p.name)}"
      role={clickable ? "button" : undefined}
      tabindex={clickable ? 0 : undefined}
      aria-label={clickable ? t("Voice settings for {name}", { name: p.name }) : undefined}
      onclick={(e) => store.openUserMenu(e, p)}
      oncontextmenu={(e) => store.openUserMenu(e, p)}
      onkeydown={(e) => store.openUserMenu(e, p)}
    >
      <!-- Camera video will render here; the avatar is the no-video fallback. -->
      <div class="tile-media">
        <div class="tile-avatar"><UserAvatar name={p.name} src={p.avatar} /></div>
      </div>
      <div class="tile-label">
        <span class="tile-name">{p.name}</span>
        {#if store.userAudioFor(p.identity).muted}
          <span class="tile-icon muted-by-me" role="img" aria-label={t("Muted for you")}><VoiceIcon kind="mic" slashed size={16} /></span>
        {:else if p.muted}
          <span class="tile-icon" role="img" aria-label={t("Muted")}><VoiceIcon kind="mic" slashed size={16} /></span>
        {/if}
        {#if p.deafened}
          <span class="tile-icon" role="img" aria-label={t("Deafened")}><VoiceIcon kind="headphones" slashed size={16} /></span>
        {/if}
      </div>
    </div>
  {/snippet}

  {#snippet streamTile(s: ScreenStream, spotlight: boolean)}
    {@const streamMuted = !s.local && store.userAudioFor(s.identity).streamMuted}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="tile stream"
      class:spotlight
      style="--hue: {hue(s.name)}"
      oncontextmenu={(e) => { if (!s.local) store.openUserMenu(e, s, "stream"); }}
    >
      {#if s.track}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="tile-video" use:attachVideo={s.track} autoplay playsinline muted></video>
        <button
          class="tile-hit"
          aria-label={t(spotlight ? "Stop focusing {stream}" : "Focus {stream}", { stream: streamLabel(s) })}
          onclick={() => toggleFocus(s)}
        ></button>
        <div class="tile-actions">
          {#if !s.local}
            <button class="tile-action" aria-label={t("Stream volume")} use:tooltip={t("Stream volume")} onclick={(e) => store.openUserMenu(e, s, "stream")}>
              <Icon name={streamMuted ? "volumeOff" : "speaker"} />
            </button>
            <button class="tile-action" aria-label={t("Stop watching")} use:tooltip={t("Stop watching")} onclick={() => stopWatching(s)}>
              <Icon name="eyeOff" />
            </button>
          {/if}
          <button class="tile-action" aria-label={t("Fullscreen")} use:tooltip={t("Fullscreen")} onclick={toggleFullscreen}>
            <Icon name="fullscreen" />
          </button>
        </div>
      {:else}
        <div class="stream-invite">
          <span class="stream-invite-text">{t("{name} is live", { name: s.name })}</span>
          <button class="watch-btn" disabled={s.loading} onclick={() => watch(s)}>
            {t(s.loading ? "Loading…" : "Watch Stream")}
          </button>
        </div>
      {/if}
      <div class="tile-label">
        <span class="live-badge">{t("LIVE")}</span>
        <span class="tile-name">{streamLabel(s)}</span>
        {#if streamMuted}
          <span class="tile-icon muted-by-me" role="img" aria-label={t("Stream muted for you")}><Icon name="volumeOff" size={16} /></span>
        {/if}
      </div>
    </div>
  {/snippet}

  <!-- The header spans the call and the member list, as in the chat view. -->
  <div class="call-body">
    <div class="call-column">
      <div class="stage" class:focus={!!focused}>
        {#if focused}
          <div class="spotlight-area">
            {@render streamTile(focused, true)}
          </div>
        {/if}
        <div class:grid={!focused} class:strip={!!focused} style:--cols={cols} style:--rows={rows}>
          {#each tiledStreams as s (s.identity)}
            {@render streamTile(s, false)}
          {/each}
          {#each store.voiceParticipants as p (p.identity)}
            {@render personTile(p)}
          {/each}
        </div>
      </div>

      <div class="controls">
        <button class="ctrl" aria-disabled="true" aria-label={t("Turn on camera")} use:tooltip={t("Camera is coming soon")}>
          <Icon name="camera" size={24} />
        </button>
        <button
          class="ctrl"
          class:sharing={store.screenSharing}
          aria-disabled={!store.canScreenShare}
          aria-pressed={store.screenSharing}
          aria-label={store.shareLabel}
          use:tooltip={store.shareLabel}
          onclick={() => store.toggleScreenShare()}
        >
          <Icon name="screenShare" size={24} />
        </button>
        <button
          class="ctrl"
          aria-label={t("Soundboard")}
          aria-expanded={soundboardOpen}
          use:tooltip={t("Soundboard")}
          bind:this={soundboardBtn}
          onclick={() => (soundboardOpen = !soundboardOpen)}
        >
          <Icon name="soundboard" size={24} />
        </button>
        {#if soundboardOpen && soundboardBtn}
          <Soundboard anchor={soundboardBtn} onclose={() => (soundboardOpen = false)} />
        {/if}

        <span class="divider" aria-hidden="true"></span>

        <button
          class="ctrl"
          class:off={store.voiceMuted}
          aria-label={store.muteLabel}
          aria-pressed={store.voiceMuted}
          use:tooltip={store.muteLabel}
          onclick={() => store.toggleMute()}
        >
          <VoiceIcon kind="mic" slashed={store.voiceMuted} size={24} />
        </button>
        <button
          class="ctrl"
          class:off={store.voiceDeafened}
          aria-label={store.deafenLabel}
          aria-pressed={store.voiceDeafened}
          use:tooltip={store.deafenLabel}
          onclick={() => store.toggleDeafen()}
        >
          <VoiceIcon kind="headphones" slashed={store.voiceDeafened} size={24} />
        </button>
        <button class="ctrl hangup" aria-label={t("Disconnect")} use:tooltip={t("Disconnect")} onclick={() => store.leaveVoice()}>
          <Icon name="hangup" size={24} />
        </button>
      </div>
    </div>
    {#if store.showMembers}
      <MemberList />
    {/if}
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

  /* Same size as the chat header, so switching views doesn't shift anything. */
  .call-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    padding: 0 12px 0 16px;
    border-bottom: 1px solid #2a2d4a;
    color: #e8eaf6;
    font-weight: 600;
    font-size: 15px;
    flex-shrink: 0;
  }

  .header-icon {
    display: flex;
    color: #8a90b4;
  }

  .header-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .call-body {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .call-column {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
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

  .tile.clickable {
    cursor: pointer;
    transition: background 0.1s;
  }

  .tile.clickable:hover,
  .tile.clickable:focus-visible { background: hsl(var(--hue) 30% 27%); }

  .tile.clickable:focus-visible { outline: 2px solid #7c5cbf; outline-offset: -2px; }

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

  .tile-icon.muted-by-me { color: #f87171; }

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
