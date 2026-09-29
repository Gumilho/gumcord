<script lang="ts">
  import { onMount } from "svelte";
  import { store, type AudioDeviceKind } from "$lib/store.svelte.ts";
  import { canPickOutput } from "$lib/audio.ts";
  import Modal from "$lib/components/Modal.svelte";
  import UserAvatar from "$lib/components/UserAvatar.svelte";

  // Your own settings, remembered on this device.
  let { onclose }: { onclose: () => void } = $props();

  // ── Profile ──
  // svelte-ignore state_referenced_locally
  let name = $state(store.me?.name ?? "");
  let profileError = $state("");
  let busy = $state(false);
  let photoInput: HTMLInputElement | null = $state(null);

  async function run(action: Promise<string>) {
    busy = true;
    profileError = await action;
    busy = false;
    if (!profileError) name = store.me?.name ?? name;
  }

  function saveName(e: SubmitEvent) {
    e.preventDefault();
    if (name.trim()) void run(store.updateName(name.trim()));
  }

  function pickPhoto(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void run(store.setAvatar(file));
  }

  // ── Voice ──
  let devices: MediaDeviceInfo[] = $state([]);
  // Browsers only reveal device names (and usable IDs) once the site may use the microphone.
  const named = $derived(devices.some((d) => d.label));

  async function refresh() {
    devices = (await navigator.mediaDevices?.enumerateDevices()) ?? [];
  }

  async function allowMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // Denied: the hint stays up.
    }
    await refresh();
  }

  onMount(() => {
    // Without names the saved choices can't be shown, so ask for the microphone right away.
    void refresh().then(() => (named ? undefined : allowMic()));
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  });

  // Chromium lists a "default" entry itself; elsewhere the system default is offered explicitly.
  function options(kind: AudioDeviceKind) {
    const list = devices.filter((d) => d.kind === kind && d.deviceId);
    const hasDefault = list.some((d) => d.deviceId === "default");
    return [
      ...(hasDefault ? [] : [{ id: "default", label: "System default" }]),
      ...list.map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === "audioinput" ? "Microphone" : "Speakers"} ${i + 1}` })),
    ];
  }

  // A saved device that's been unplugged shows as the default, which is what gets used.
  function selected(kind: AudioDeviceKind) {
    const saved = store.devices[kind];
    return saved && options(kind).some((o) => o.id === saved) ? saved : "default";
  }
</script>

<Modal title="User settings" {onclose}>
  <section>
    <h3>Profile</h3>
    <div class="profile">
      <div class="big-avatar"><UserAvatar name={store.me?.name ?? ""} src={store.me?.avatar} /></div>
      <div class="photo-actions">
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden bind:this={photoInput} onchange={pickPhoto} />
        <button class="primary" type="button" disabled={busy} onclick={() => photoInput?.click()}>Change photo</button>
        <button class="link" type="button" disabled={busy} onclick={() => run(store.resetAvatar())}>Use my PocketID photo</button>
      </div>
    </div>
    <form class="row" onsubmit={saveName}>
      <label class="field">
        <span>Display name</span>
        <input bind:value={name} maxlength="32" />
      </label>
      <button class="primary" type="submit" disabled={busy || !name.trim() || name.trim() === store.me?.name}>Save</button>
    </form>
    <button class="link" type="button" disabled={busy} onclick={() => run(store.updateName(""))}>Use my PocketID name</button>
    {#if profileError}<p class="error">{profileError}</p>{/if}
  </section>

  <section>
    <h3>Voice</h3>
    <label class="field">
      <span>Microphone</span>
      <select value={selected("audioinput")} onchange={(e) => store.setDevice("audioinput", e.currentTarget.value)}>
        {#each options("audioinput") as o (o.id)}
          <option value={o.id}>{o.label}</option>
        {/each}
      </select>
    </label>

    {#if canPickOutput}
      <label class="field">
        <span>Speakers</span>
        <select value={selected("audiooutput")} onchange={(e) => store.setDevice("audiooutput", e.currentTarget.value)}>
          {#each options("audiooutput") as o (o.id)}
            <option value={o.id}>{o.label}</option>
          {/each}
        </select>
      </label>
    {:else}
      <p class="hint">This browser always plays through the system's default speakers.</p>
    {/if}

    {#if !named}
      <p class="hint">
        Your devices' names show up once Gumcord may use the microphone.
        <button class="link" type="button" onclick={allowMic}>Allow</button>
      </p>
    {/if}
  </section>
</Modal>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  section + section {
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid #2e3154;
  }

  .profile {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .big-avatar {
    width: 72px;
    height: 72px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: #5b40c2;
    color: #fff;
    font-size: 28px;
    font-weight: 700;
  }

  .photo-actions {
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

  .row .field { flex: 1; }

  input:not([type="file"]) {
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
    margin: 0;
    color: #f87171;
    font-size: 13px;
  }

  h3 {
    margin: 0;
    color: #e8eaf6;
    font-size: 14px;
  }

  .field {
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

  select {
    padding: 9px 12px;
    border: 1px solid #33365a;
    border-radius: 7px;
    background: #1a1b2e;
    color: #d4d8f0;
    font: inherit;
    font-size: 14px;
    outline: none;
  }

  select:focus { border-color: #7c5cbf; }

  .hint {
    margin: 0;
    color: #6b7290;
    font-size: 13px;
  }

  .link {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    color: #a78bfa;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .link:disabled { opacity: 0.5; cursor: default; }

  .link:hover { text-decoration: underline; }
</style>
