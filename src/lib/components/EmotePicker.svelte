<script lang="ts">
  import { onDestroy } from "svelte";
  import { store, type Emote, type ServerItem } from "$lib/store.svelte.ts";
  import Icon from "$lib/components/Icon.svelte";
  import { t } from "$lib/i18n.svelte.ts";
  import { chosenFile, isImage, pastedFile } from "$lib/files.ts";

  // The open server's emotes and stickers, above the message box: pick one (a sticker is sent right
  // away), add your own, or remove one you added.
  let { onpick, onclose }: { onpick: (emote: Emote, keepOpen: boolean) => void; onclose: () => void } = $props();

  let tab: "emotes" | "stickers" = $state("emotes");
  let search = $state("");
  let error = $state("");
  let busy = $state(false);
  let confirming: number | null = $state(null); // removing takes a second click
  let fileInput: HTMLInputElement | null = $state(null);
  let adding: { file: File; preview: string } | null = $state(null);
  let newName = $state("");
  let picker: HTMLElement | null = $state(null);

  const emotes = $derived(tab === "emotes");
  const items = $derived(emotes ? store.emotes : store.stickers);
  const shown = $derived(items.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase())));
  // Emote names are written in messages, so they're letters, digits and _; sticker names are just labels.
  const nameOk = $derived(emotes ? /^[A-Za-z0-9_]{2,32}$/.test(newName.trim()) : !!newName.trim());

  // "party parrot.gif" → "party_parrot" for an emote, "party parrot" for a sticker
  function nameFromFile(file: File) {
    const base = file.name.replace(/\.[^.]*$/, "");
    if (!emotes) return base.replace(/[-_]+/g, " ").trim().slice(0, 32);
    const name = base.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
    return name.length >= 2 ? name : "";
  }

  function switchTab(next: typeof tab) {
    tab = next;
    search = "";
    error = "";
    confirming = null;
    stopAdding();
  }

  // A picture chosen with "Add" or pasted, ready to name and save on the open tab.
  function startAdding(file: File | null) {
    if (!file) return;
    stopAdding();
    adding = { file, preview: URL.createObjectURL(file) };
    newName = nameFromFile(file);
    error = "";
  }

  function stopAdding() {
    if (adding) URL.revokeObjectURL(adding.preview);
    adding = null;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!adding) return;
    busy = true;
    error = await store.addItem(tab, newName.trim(), adding.file);
    busy = false;
    if (!error) stopAdding();
  }

  async function remove(item: ServerItem) {
    if (confirming !== item.id) {
      confirming = item.id;
      return;
    }
    confirming = null;
    error = await store.removeItem(tab, item);
  }

  function pick(item: ServerItem, e: MouseEvent) {
    if (emotes) return onpick(item, e.shiftKey);
    store.sendSticker(item);
    if (!e.shiftKey) onclose();
  }

  // A click anywhere else closes it (the toggle button handles its own clicks).
  function onPointerDown(e: PointerEvent) {
    const target = e.target as Element;
    if (!picker?.contains(target) && !target.closest?.(".emote-btn")) onclose();
  }

  function focusSearch(node: HTMLInputElement) {
    node.focus();
  }

  onDestroy(stopAdding);
</script>

<svelte:window
  onpointerdown={onPointerDown}
  onkeydown={(e) => { if (e.key === "Escape") onclose(); }}
  onpaste={(e) => startAdding(pastedFile(e, isImage))}
/>

<div class="picker" role="dialog" aria-label={t("Emotes and stickers")} bind:this={picker}>
  <div class="tabs" role="tablist">
    <button type="button" role="tab" aria-selected={emotes} onclick={() => switchTab("emotes")}>{t("Emotes")}</button>
    <button type="button" role="tab" aria-selected={!emotes} onclick={() => switchTab("stickers")}>{t("Stickers")}</button>
  </div>

  <div class="top">
    <input class="search" placeholder={t(emotes ? "Find an emote" : "Find a sticker")} aria-label={t(emotes ? "Find an emote" : "Find a sticker")} bind:value={search} {@attach focusSearch} />
    <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" bind:this={fileInput} onchange={(e) => startAdding(chosenFile(e))} />
    <button class="add-btn" type="button" onclick={() => fileInput?.click()}>{t(emotes ? "Add emote" : "Add sticker")}</button>
  </div>

  {#if adding}
    <form class="adding" onsubmit={save}>
      <img src={adding.preview} alt="" />
      <input bind:value={newName} maxlength="32" placeholder={t("name")} aria-label={t(emotes ? "Emote name" : "Sticker name")} />
      <button class="primary" type="submit" disabled={busy || !nameOk}>{t("Save")}</button>
      <button class="cancel" type="button" onclick={stopAdding}>{t("Cancel")}</button>
    </form>
    {#if emotes && newName.trim() && !nameOk}<p class="error">{t("names are 2-32 letters, digits or _")}</p>{/if}
  {/if}
  {#if error}<p class="error">{error}</p>{/if}

  {#if items.length === 0}
    <p class="empty">{t(emotes ? "No emotes in {server} yet. Add the first one!" : "No stickers in {server} yet. Add the first one!", { server: store.activeServer?.name ?? t("this server") })}</p>
  {:else if shown.length === 0}
    <p class="empty">{t(emotes ? "No emotes match “{search}”." : "No stickers match “{search}”.", { search: search.trim() })}</p>
  {:else}
    <div class="grid" class:stickers={!emotes}>
      {#each shown as item (item.id)}
        {@const label = emotes ? `:${item.name}:` : item.name}
        <div class="tile">
          <button class="pick" type="button" title={label} onclick={(e) => pick(item, e)}>
            <img src={item.url} alt={label} loading="lazy" />
          </button>
          {#if store.canRemove(item)}
            <button
              class="remove"
              class:confirming={confirming === item.id}
              type="button"
              aria-label={t("Remove {name}", { name: label })}
              title={confirming === item.id ? t("Click again to remove") : t("Remove {name}", { name: label })}
              onclick={() => remove(item)}
            >
              <Icon name="close" size={12} />
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  <p class="hint">
    {t(emotes ? "Type :name: in a message, or start with : to search. Shift-click to pick several." : "Click a sticker to send it. Shift-click to send several.")}
    {t(emotes ? "Paste a picture to add it as an emote." : "Paste a picture to add it as a sticker.")}
  </p>
</div>

<style>
  .picker {
    position: absolute;
    right: 16px;
    bottom: calc(100% - 16px);
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(360px, calc(100% - 32px));
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

  input:not([type="file"]) {
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

  .adding img {
    width: 32px;
    height: 32px;
    object-fit: contain;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
    gap: 4px;
    max-height: 220px;
    /* Room for the remove buttons that sit over the tiles' corners, so they never make it scroll sideways. */
    margin: -4px;
    padding: 4px;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .tile { position: relative; }

  .pick {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 1;
    padding: 4px;
    border: none;
    border-radius: 6px;
    background: none;
    cursor: pointer;
  }

  .pick:hover, .pick:focus-visible { background: #2a2c48; }

  .pick img {
    width: 32px;
    height: 32px;
    object-fit: contain;
  }

  .grid.stickers { grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); }
  .grid.stickers .pick img { width: 68px; height: 68px; }

  .tabs {
    display: flex;
    gap: 4px;
  }

  .tabs button {
    padding: 5px 10px;
    border: none;
    border-radius: 5px;
    background: none;
    color: #8a90b4;
    font: 600 13px system-ui, sans-serif;
    cursor: pointer;
  }

  .tabs button:hover { color: #e4e6f5; }
  .tabs button[aria-selected="true"] { background: #2a2c48; color: #fff; }

  .remove {
    position: absolute;
    top: -2px;
    right: -2px;
    display: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: #3a3d5c;
    color: #e4e6f5;
    cursor: pointer;
  }

  .tile:hover .remove, .remove:focus-visible, .remove.confirming { display: flex; }
  .remove.confirming { background: #dc2626; }

  .empty, .hint, .error {
    margin: 0;
    font-size: 12px;
  }

  .empty { color: #8a90b4; padding: 8px 0; }
  .hint { color: #5c6283; }
  .error { color: #f87171; }
</style>
