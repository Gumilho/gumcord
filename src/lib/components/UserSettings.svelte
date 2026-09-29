<script lang="ts">
  import { onMount } from "svelte";
  import { store, type AudioDeviceKind } from "$lib/store.svelte.ts";
  import { canPickOutput } from "$lib/audio.ts";
  import Modal from "$lib/components/Modal.svelte";

  // Your own settings, remembered on this device.
  let { onclose }: { onclose: () => void } = $props();

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
    padding: 0;
    border: none;
    background: none;
    color: #a78bfa;
    font: inherit;
    cursor: pointer;
  }

  .link:hover { text-decoration: underline; }
</style>
