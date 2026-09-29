<script lang="ts">
  import { onMount } from "svelte";
  import { store, type Server, type User } from "$lib/store.svelte.ts";
  import { t } from "$lib/i18n.svelte.ts";
  import Modal from "$lib/components/Modal.svelte";
  import UserAvatar from "$lib/components/UserAvatar.svelte";
  import { hue, initials } from "$lib/avatar.ts";

  // Admins only: rename a server, add and remove its members, or delete it.
  let { server, onclose }: { server: Server; onclose: () => void } = $props();

  // The field starts from the current name, then it's yours to edit.
  // svelte-ignore state_referenced_locally
  let name = $state(server.name);
  let everyone: User[] = $state([]);
  let adding = $state("");
  let error = $state("");
  let confirmDelete = $state(false);

  const members = $derived(store.activeServer?.id === server.id ? store.members : []);
  // People who have signed in but aren't in this server yet.
  const addable = $derived(everyone.filter((u) => !members.some((m) => m.id === u.id)));

  onMount(async () => {
    everyone = await store.allUsers();
  });

  async function run(action: Promise<string>) {
    error = await action;
    return !error;
  }

  let iconInput: HTMLInputElement | null = $state(null);

  function pickIcon(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void run(store.setServerIcon(server.id, file));
  }

  async function rename(e: SubmitEvent) {
    e.preventDefault();
    if (name.trim() && name.trim() !== server.name) await run(store.renameServer(server.id, name.trim()));
  }

  async function add() {
    if (adding && (await run(store.addMember(server.id, Number(adding))))) adding = "";
  }

  async function remove() {
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    if (await run(store.deleteServer(server.id))) onclose();
  }
</script>

<Modal title={t("Server settings")} {onclose}>
  <div class="icon-row">
    <div class="server-icon" style="--hue: {hue(server.name)}">
      <UserAvatar name={server.name} src={server.icon} letters={initials(server.name)} />
    </div>
    <div class="icon-actions">
      <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" bind:this={iconInput} onchange={pickIcon} />
      <button class="primary" type="button" onclick={() => iconInput?.click()}>{t("Change image")}</button>
      {#if server.icon}
        <button class="link" type="button" onclick={() => run(store.removeServerIcon(server.id))}>{t("Remove image")}</button>
      {/if}
    </div>
  </div>

  <form class="row" onsubmit={rename}>
    <label class="field">
      <span>{t("Server name")}</span>
      <input bind:value={name} maxlength="64" />
    </label>
    <button class="primary" type="submit" disabled={!name.trim() || name.trim() === server.name}>{t("Save")}</button>
  </form>

  <section>
    <h3>{t("Members — {count}", { count: members.length })}</h3>
    <ul class="members">
      {#each members as m (m.id)}
        <li>
          <div class="avatar"><UserAvatar name={m.name} src={m.avatar} /></div>
          <span class="name">{m.name}</span>
          {#if m.admin}<span class="badge">{t("Admin")}</span>{/if}
          <button class="link danger" type="button" onclick={() => run(store.removeMember(server.id, m.id))}>{t("Remove")}</button>
        </li>
      {/each}
    </ul>

    {#if addable.length > 0}
      <div class="row">
        <select bind:value={adding} aria-label={t("Person to add")}>
          <option value="" disabled>{t("Add someone…")}</option>
          {#each addable as u (u.id)}
            <option value={String(u.id)}>{u.name}</option>
          {/each}
        </select>
        <button class="primary" type="button" disabled={!adding} onclick={add}>{t("Add")}</button>
      </div>
    {:else}
      <p class="hint">{t("Everyone who has signed in is already a member. People appear here after their first sign-in.")}</p>
    {/if}
  </section>

  {#if error}<p class="error">{error}</p>{/if}

  <section class="danger-zone">
    <p class="hint">{t("Deleting removes the server's channels and messages for everyone, and ends its calls.")}</p>
    <button class="delete" type="button" onclick={remove}>
      {confirmDelete ? t("Click again to delete “{name}”", { name: server.name }) : t("Delete server")}
    </button>
  </section>
</Modal>

<style>
  .icon-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }

  .server-icon {
    width: 72px;
    height: 72px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 20px;
    background: hsl(var(--hue) 35% 32%);
    color: #fff;
    font: 700 24px system-ui, sans-serif;
  }

  .icon-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

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

  .field span,
  h3 {
    margin: 0;
    color: #8a90b4;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  input,
  select {
    flex: 1;
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

  input:focus,
  select:focus { border-color: #7c5cbf; }

  section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 20px;
  }

  .members {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .members li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 6px;
    border-radius: 6px;
  }

  .members li:hover { background: #23253a; }

  .avatar {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: #5b40c2;
    color: #fff;
    font-size: 13px;
    font-weight: 700;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: #d4d8f0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    padding: 1px 6px;
    border-radius: 4px;
    background: #2e2a55;
    color: #a78bfa;
    font-size: 11px;
    font-weight: 700;
  }

  .link {
    padding: 2px 4px;
    border: none;
    background: none;
    color: #a78bfa;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .link.danger { color: #f87171; }
  .link:hover { text-decoration: underline; }

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

  .hint {
    margin: 0;
    color: #6b7290;
    font-size: 13px;
  }

  .error {
    margin: 16px 0 0;
    color: #f87171;
    font-size: 13px;
  }

  .danger-zone {
    padding-top: 16px;
    border-top: 1px solid #2e3154;
  }

  .delete {
    align-self: flex-start;
    padding: 8px 14px;
    border: 1px solid #7f1d1d;
    border-radius: 6px;
    background: none;
    color: #f87171;
    font: 600 14px system-ui, sans-serif;
    cursor: pointer;
  }

  .delete:hover {
    background: #7f1d1d;
    color: #fecaca;
  }
</style>
