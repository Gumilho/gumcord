<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { store, type Sound } from "$lib/store.svelte.ts";
  import { clipDuration, MAX_CLIP_SECONDS, playClip } from "$lib/sounds.ts";
  import Icon from "$lib/components/Icon.svelte";
  import { t } from "$lib/i18n.svelte.ts";

  // The call's soundboard, over the button that opened it: play a sound to everyone, try one on
  // your own, add your own, or remove one you added.
  let { anchor, onclose }: { anchor: HTMLElement; onclose: () => void } = $props();

  const WIDTH = 340;
  let pos = $state({ left: 0, bottom: 0 });
  let panel: HTMLElement | null = $state(null);
  let error = $state("");
  let busy = $state(false);
  let confirming: number | null = $state(null); // removing takes a second click
  let played: number | null = $state(null);
  let playedTimer: ReturnType<typeof setTimeout> | undefined;
  let fileInput: HTMLInputElement | null = $state(null);
  let adding: { file: File; url: string } | null = $state(null);
  let newName = $state("");

  function place() {
    const r = anchor.getBoundingClientRect();
    pos = {
      left: Math.min(Math.max(r.left + r.width / 2 - WIDTH / 2, 8), innerWidth - WIDTH - 8),
      bottom: innerHeight - r.top + 8,
    };
  }
  onMount(place);

  function play(sound: Sound) {
    store.playSoundboard(sound);
    played = sound.id;
    clearTimeout(playedTimer);
    playedTimer = setTimeout(() => (played = null), 400);
  }

  // "air-horn_2.mp3" → "air horn 2"
  function nameFromFile(file: File) {
    return file.name.replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ").trim().slice(0, 32);
  }

  async function pickFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    stopAdding();
    const seconds = await clipDuration(file);
    if (seconds === null) {
      error = t("That file isn't a sound this app can play. Use an MP3, OGG or WAV.");
      return;
    }
    if (seconds > MAX_CLIP_SECONDS) {
      error = t("Sounds can be up to {max} seconds; this one is {length}.", { max: MAX_CLIP_SECONDS, length: seconds.toFixed(1) });
      return;
    }
    adding = { file, url: URL.createObjectURL(file) };
    newName = nameFromFile(file);
    error = "";
  }

  function stopAdding() {
    if (adding) URL.revokeObjectURL(adding.url);
    adding = null;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!adding) return;
    busy = true;
    error = await store.addItem("sounds", newName.trim(), adding.file);
    busy = false;
    if (!error) stopAdding();
  }

  async function remove(sound: Sound) {
    if (confirming !== sound.id) {
      confirming = sound.id;
      return;
    }
    confirming = null;
    error = await store.removeItem("sounds", sound);
  }

  function onPointerDown(e: PointerEvent) {
    const target = e.target as Node;
    if (!panel?.contains(target) && !anchor.contains(target)) onclose();
  }

  onDestroy(() => {
    stopAdding();
    clearTimeout(playedTimer);
  });
</script>

<svelte:window onpointerdown={onPointerDown} onresize={place} onkeydown={(e) => { if (e.key === "Escape") onclose(); }} />

<div class="soundboard" role="dialog" aria-label={t("Soundboard")} bind:this={panel} style:left="{pos.left}px" style:bottom="{pos.bottom}px" style:width="{WIDTH}px">
  <div class="top">
    <h3>{t("Soundboard")} <span>{store.voiceServer?.name ?? ""}</span></h3>
    <input type="file" hidden accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav" bind:this={fileInput} onchange={pickFile} />
    <button class="add-btn" type="button" onclick={() => fileInput?.click()}>{t("Add sound")}</button>
  </div>

  {#if adding}
    <form class="adding" onsubmit={save}>
      <button class="icon" type="button" aria-label={t("Listen")} title={t("Listen")} onclick={() => adding && playClip(adding.url, store.soundboardVolume)}>
        <Icon name="speaker" size={16} />
      </button>
      <input bind:value={newName} maxlength="32" placeholder={t("name")} aria-label={t("Sound name")} />
      <button class="primary" type="submit" disabled={busy || !newName.trim()}>{t("Save")}</button>
      <button class="cancel" type="button" onclick={stopAdding}>{t("Cancel")}</button>
    </form>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
  {#if store.voiceDeafened}<p class="note">{t("You're deafened: you won't hear sounds, but others will.")}</p>{/if}

  {#if store.sounds.length === 0}
    <p class="empty">{t("No sounds in {server} yet. Add the first one!", { server: store.voiceServer?.name ?? t("this server") })}</p>
  {:else}
    <div class="grid">
      {#each store.sounds as sound (sound.id)}
        <div class="tile" class:played={played === sound.id}>
          <button class="play" type="button" title={t("Play for everyone in the call")} onclick={() => play(sound)}>{sound.name}</button>
          <button class="icon preview" type="button" aria-label={t("Listen to {name}", { name: sound.name })} title={t("Only you hear it")} onclick={() => store.previewSound(sound)}>
            <Icon name="speaker" size={14} />
          </button>
          {#if store.canRemove(sound)}
            <button
              class="icon remove"
              class:confirming={confirming === sound.id}
              type="button"
              aria-label={t("Remove {name}", { name: sound.name })}
              title={confirming === sound.id ? t("Click again to remove") : t("Remove {name}", { name: sound.name })}
              onclick={() => remove(sound)}
            >
              <Icon name="close" size={12} />
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <label class="volume">
    <span>{t("Volume")}</span>
    <input
      type="range"
      min="0"
      max="100"
      value={Math.round(store.soundboardVolume * 100)}
      oninput={(e) => store.setSoundboardVolume(Number(e.currentTarget.value) / 100)}
    />
    <span class="pct">{Math.round(store.soundboardVolume * 100)}%</span>
  </label>
</div>

<style>
  .soundboard {
    position: fixed;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: calc(100vw - 16px);
    padding: 12px;
    border: 1px solid #2e3154;
    border-radius: 8px;
    background: #1a1b2e;
    box-shadow: 0 8px 24px #0008;
  }

  .top, .adding {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  h3 {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: #e8eaf6;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  h3 span {
    color: #6b7290;
    font-weight: 400;
  }

  input:not([type="file"], [type="range"]) {
    flex: 1;
    min-width: 0;
    padding: 7px 10px;
    border: 1px solid #33365a;
    border-radius: 6px;
    background: #23253a;
    color: #d4d8f0;
    font: inherit;
    font-size: 13px;
    outline: none;
  }

  input:focus { border-color: #7c5cbf; }

  .add-btn, .cancel {
    flex-shrink: 0;
    padding: 7px 10px;
    border: 1px solid #33365a;
    border-radius: 6px;
    background: none;
    color: #c8cce8;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .add-btn:hover, .cancel:hover { background: #23253a; }

  .primary {
    flex-shrink: 0;
    padding: 7px 12px;
    border: none;
    border-radius: 6px;
    background: #5b40c2;
    color: #fff;
    font: 600 13px system-ui, sans-serif;
    cursor: pointer;
  }

  .primary:disabled { opacity: 0.5; cursor: default; }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    max-height: 260px;
    /* Room for the remove buttons that sit over the tiles' corners, so they never make it scroll sideways. */
    margin: -6px;
    padding: 6px;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .tile {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 6px;
    background: #23253a;
    transition: background 0.15s;
  }

  .tile:hover { background: #2a2c48; }
  .tile.played { background: #3b2f7a; }

  .play {
    flex: 1;
    min-width: 0;
    padding: 9px 4px 9px 10px;
    overflow: hidden;
    border: none;
    background: none;
    color: #dbdef0;
    font: inherit;
    font-size: 13px;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 6px;
    border: none;
    border-radius: 5px;
    background: none;
    color: #8a90b4;
    cursor: pointer;
  }

  .icon:hover { color: #e4e6f5; }

  .remove {
    position: absolute;
    top: -6px;
    right: -6px;
    display: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    background: #3a3d5c;
    color: #e4e6f5;
  }

  .tile:hover .remove, .remove:focus-visible, .remove.confirming { display: flex; }
  .remove.confirming { background: #dc2626; }

  .volume {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #8a90b4;
    font-size: 12px;
  }

  .volume input {
    flex: 1;
    accent-color: #5b40c2;
  }

  .pct {
    width: 34px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .empty, .error, .note {
    margin: 0;
    font-size: 12px;
  }

  .empty { color: #8a90b4; padding: 8px 0; }
  .note { color: #fbbf24; }
  .error { color: #f87171; }
</style>
