<script lang="ts">
  import { store } from "$lib/store.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";
  import { tooltip } from "$lib/tooltip.ts";
  import { hue, initials } from "$lib/avatar.ts";
  import Icon from "$lib/components/Icon.svelte";
  import Modal from "$lib/components/Modal.svelte";

  // The server list down the far left. Admins get a button to create one.
  let creating = $state(false);
  let name = $state("");
  let error = $state("");
  let busy = $state(false);

  function openCreate() {
    name = "";
    error = "";
    creating = true;
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    busy = true;
    error = await store.createServer(name.trim());
    busy = false;
    if (!error) creating = false;
  }
</script>

<nav class="rail" aria-label={t("Servers")}>
  {#each store.servers as s (s.id)}
    {@const active = store.activeServer?.id === s.id}
    <button
      class="server"
      class:active
      class:in-voice={store.voiceChannel?.server_id === s.id}
      style="--hue: {hue(s.name)}"
      aria-label={s.name}
      aria-current={active ? "page" : undefined}
      use:tooltip={s.name}
      onclick={() => store.selectServer(s)}
    >
      {initials(s.name)}
    </button>
  {/each}

  {#if store.me?.admin}
    {#if store.servers.length > 0}<div class="divider" aria-hidden="true"></div>{/if}
    <button class="server add" aria-label={t("Create a server")} use:tooltip={t("Create a server")} onclick={openCreate}>
      <Icon name="plus" />
    </button>
  {/if}
</nav>

{#if creating}
  <Modal title={t("Create a server")} onclose={() => (creating = false)}>
    <form class="form" onsubmit={create}>
      <label>
        <span>{t("Server name")}</span>
        <input bind:value={name} maxlength="64" placeholder={t("e.g. Friends")} />
      </label>
      <p class="hint">{t("It starts with a #general text channel and a General voice channel, with you as its only member.")}</p>
      {#if error}<p class="error">{error}</p>{/if}
      <div class="actions">
        <button type="button" class="secondary" onclick={() => (creating = false)}>{t("Cancel")}</button>
        <button type="submit" class="primary" disabled={!name.trim() || busy}>{t("Create")}</button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .rail {
    width: 64px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    overflow-y: auto;
    background: #141526;
    scrollbar-width: none;
  }

  .rail::-webkit-scrollbar { display: none; }

  .server {
    position: relative;
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 50%;
    background: hsl(var(--hue) 35% 32%);
    color: #fff;
    font: 700 15px system-ui, sans-serif;
    cursor: pointer;
    transition: border-radius 0.15s, background 0.15s;
  }

  .server:hover,
  .server.active { border-radius: 14px; }

  /* The pill on the left edge marks the open server, as in Discord. */
  .server::before {
    content: "";
    position: absolute;
    left: -12px;
    width: 4px;
    height: 0;
    border-radius: 0 4px 4px 0;
    background: #e8eaf6;
    transition: height 0.15s;
  }

  .server:hover::before { height: 18px; }
  .server.active::before { height: 36px; }

  /* A green dot on the server you're in a call in, so you can find your way back. */
  .server.in-voice::after {
    content: "";
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 12px;
    height: 12px;
    border: 3px solid #141526;
    border-radius: 50%;
    background: #4ade80;
  }

  .server.add {
    background: #23253a;
    color: #4ade80;
  }

  .server.add:hover {
    background: #4ade80;
    color: #141526;
  }

  .divider {
    width: 28px;
    height: 2px;
    flex-shrink: 0;
    border-radius: 1px;
    background: #2e3154;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: #8a90b4;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  input {
    padding: 9px 12px;
    border: 1px solid #33365a;
    border-radius: 7px;
    background: #1a1b2e;
    color: #d4d8f0;
    font: inherit;
    font-size: 14px;
    letter-spacing: 0;
    text-transform: none;
    outline: none;
  }

  input:focus { border-color: #7c5cbf; }

  .hint {
    margin: 0;
    color: #6b7290;
    font-size: 13px;
  }

  .error {
    margin: 0;
    color: #f87171;
    font-size: 13px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .primary,
  .secondary {
    padding: 8px 16px;
    border-radius: 6px;
    font: 600 14px system-ui, sans-serif;
    cursor: pointer;
  }

  .primary {
    border: none;
    background: #5b40c2;
    color: #fff;
  }

  .primary:hover:not(:disabled) { background: #6d50d6; }
  .primary:disabled { opacity: 0.5; cursor: default; }

  .secondary {
    border: 1px solid #33365a;
    background: none;
    color: #c8cce8;
  }

  .secondary:hover { background: #2a2d4a; }
</style>
