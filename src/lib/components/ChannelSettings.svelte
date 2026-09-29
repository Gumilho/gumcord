<script lang="ts">
  import { store, type Channel } from "$lib/store.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";
  import Modal from "$lib/components/Modal.svelte";

  // Admins only: rename a channel, or delete it. Opened from "Delete Channel", deleting is one click away.
  let { channel, deleting = false, onclose }: { channel: Channel; deleting?: boolean; onclose: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(channel.name);
  let error = $state("");
  // svelte-ignore state_referenced_locally
  let confirmDelete = $state(deleting);

  async function rename(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === channel.name) return;
    error = await store.renameChannel(channel.id, name.trim());
    if (!error) onclose();
  }

  async function remove() {
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    error = await store.deleteChannel(channel.id);
    if (!error) onclose();
  }
</script>

<Modal title={t("Channel settings")} {onclose}>
  <form class="row" onsubmit={rename}>
    <label class="field">
      <span>{t("Channel name")}</span>
      <input bind:value={name} maxlength="64" />
    </label>
    <button class="primary" type="submit" disabled={!name.trim() || name.trim() === channel.name}>{t("Save")}</button>
  </form>

  {#if error}<p class="error">{error}</p>{/if}

  <section class="danger-zone">
    <p class="hint">
      {t(channel.kind === "text"
        ? "Deleting removes the channel and all its messages for everyone."
        : "Deleting removes the channel for everyone and ends its call.")}
    </p>
    <button class="delete" type="button" onclick={remove}>
      {confirmDelete ? t("Click again to delete “{name}”", { name: channel.name }) : t("Delete channel")}
    </button>
  </section>
</Modal>

<style>
  .row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }

  .field {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field span {
    color: #8a90b4;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  input {
    min-width: 0;
    padding: 9px 12px;
    border: 1px solid #33365a;
    border-radius: 7px;
    background: #1a1b2e;
    color: #d4d8f0;
    font: inherit;
    font-size: 14px;
    outline: none;
  }

  input:focus { border-color: #7c5cbf; }

  .primary {
    padding: 9px 16px;
    border: none;
    border-radius: 6px;
    background: #5b40c2;
    color: #fff;
    font: 600 14px system-ui, sans-serif;
    cursor: pointer;
  }

  .primary:hover:not(:disabled) { background: #6d50d6; }
  .primary:disabled { opacity: 0.5; cursor: default; }

  .error {
    margin: 12px 0 0;
    color: #f87171;
    font-size: 13px;
  }

  .danger-zone {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid #2e3154;
  }

  .hint {
    margin: 0;
    color: #6b7290;
    font-size: 13px;
  }

  .delete {
    padding: 8px 14px;
    border: 1px solid #7f1d1d;
    border-radius: 6px;
    background: none;
    color: #f87171;
    font: 600 14px system-ui, sans-serif;
    cursor: pointer;
  }

  .delete:hover { background: #7f1d1d; color: #fecaca; }
</style>
