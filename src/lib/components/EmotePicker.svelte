<script lang="ts">
  import { onDestroy } from "svelte";
  import { store, type Emote } from "$lib/store.svelte.ts";
  import Icon from "$lib/components/Icon.svelte";
  import { t } from "$lib/i18n.svelte.ts";

  // The open server's emotes, above the message box: pick one, add your own, or remove one you added.
  let { onpick, onclose }: { onpick: (emote: Emote, keepOpen: boolean) => void; onclose: () => void } = $props();

  let search = $state("");
  let error = $state("");
  let busy = $state(false);
  let confirming: number | null = $state(null); // removing takes a second click
  let fileInput: HTMLInputElement | null = $state(null);
  let adding: { file: File; preview: string } | null = $state(null);
  let newName = $state("");
  let picker: HTMLElement | null = $state(null);

  const shown = $derived(store.emotes.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase())));

  // "party parrot.gif" → "party_parrot"
  function nameFromFile(file: File) {
    const name = file.name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
    return name.length >= 2 ? name : "";
  }

  function pickFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
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
    error = await store.addItem("emotes", newName.trim(), adding.file);
    busy = false;
    if (!error) stopAdding();
  }

  async function remove(emote: Emote) {
    if (confirming !== emote.id) {
      confirming = emote.id;
      return;
    }
    confirming = null;
    error = await store.removeItem("emotes", emote);
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

<svelte:window onpointerdown={onPointerDown} onkeydown={(e) => { if (e.key === "Escape") onclose(); }} />

<div class="picker" role="dialog" aria-label={t("Emotes")} bind:this={picker}>
  <div class="top">
    <input class="search" placeholder={t("Find an emote")} aria-label={t("Find an emote")} bind:value={search} {@attach focusSearch} />
    <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" bind:this={fileInput} onchange={pickFile} />
    <button class="add-btn" type="button" onclick={() => fileInput?.click()}>{t("Add emote")}</button>
  </div>

  {#if adding}
    <form class="adding" onsubmit={save}>
      <img src={adding.preview} alt="" />
      <input bind:value={newName} maxlength="32" placeholder={t("name")} aria-label={t("Emote name")} />
      <button class="primary" type="submit" disabled={busy || newName.trim().length < 2}>{t("Save")}</button>
      <button class="cancel" type="button" onclick={stopAdding}>{t("Cancel")}</button>
    </form>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}

  {#if store.emotes.length === 0}
    <p class="empty">{t("No emotes in {server} yet. Add the first one!", { server: store.activeServer?.name ?? t("this server") })}</p>
  {:else if shown.length === 0}
    <p class="empty">{t("No emotes match “{search}”.", { search: search.trim() })}</p>
  {:else}
    <div class="grid">
      {#each shown as emote (emote.id)}
        <div class="tile">
          <button class="pick" type="button" title=":{emote.name}:" onclick={(e) => onpick(emote, e.shiftKey)}>
            <img src={emote.url} alt=":{emote.name}:" loading="lazy" />
          </button>
          {#if store.canRemove(emote)}
            <button
              class="remove"
              class:confirming={confirming === emote.id}
              type="button"
              aria-label={t("Remove :{name}:", { name: emote.name })}
              title={confirming === emote.id ? t("Click again to remove") : t("Remove :{name}:", { name: emote.name })}
              onclick={() => remove(emote)}
            >
              <Icon name="close" size={12} />
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  <p class="hint">{t("Type :name: in a message, or start with : to search. Shift-click to pick several.")}</p>
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
