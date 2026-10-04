<script lang="ts">
  import { onMount } from "svelte";
  import { isDesktop, store, type AudioDeviceKind, type KeybindAction, type NoiseSuppression } from "$lib/store.svelte.ts";
  import { keybindFromEvent, keybindLabel, systemWide } from "$lib/shortcuts.svelte.ts";
  import { i18n, LANGUAGES, setLang, t, type Lang } from "$lib/i18n.svelte.ts";
  import { chosenFile, isImage, pastedFile } from "$lib/files.ts";
  import { canPickOutput } from "$lib/audio.ts";
  import { canSuppressNoise } from "$lib/noise.ts";
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

  // A picture chosen with "Change photo", or pasted while the settings are open.
  function usePhoto(file: File | null) {
    if (file) void run(store.setAvatar(file));
  }

  // ── Keybinds ──
  const KEYBIND_ROWS: { action: KeybindAction; label: string }[] = [
    { action: "toggleMute", label: "Toggle mute" },
    { action: "toggleDeafen", label: "Toggle deafen" },
    { action: "pushToTalk", label: "Push to talk" },
  ];
  let recording: KeybindAction | null = $state(null);

  function setBind(action: KeybindAction, bind: ReturnType<typeof keybindFromEvent>) {
    store.setKeybinds({ ...store.keybinds, binds: { ...store.keybinds.binds, [action]: bind } });
  }

  function startRecording(action: KeybindAction) {
    recording = action;
    store.recordingKeybind = true;
  }

  function stopRecording() {
    recording = null;
    store.recordingKeybind = false;
  }

  // Captures the next key or mouse button for the row being changed; Escape cancels.
  function onRecordKey(e: KeyboardEvent | MouseEvent) {
    if (!recording) return;
    if (e instanceof MouseEvent && keybindFromEvent(e) === null) return; // left/right clicks still work the UI
    e.preventDefault();
    e.stopPropagation();
    if (e instanceof KeyboardEvent && e.key === "Escape") return stopRecording();
    const bind = keybindFromEvent(e);
    if (!bind) return; // a lone modifier: wait for the key
    setBind(recording, bind);
    stopRecording();
  }

  onMount(() => stopRecording); // never leave shortcuts paused

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
      ...(hasDefault ? [] : [{ id: "default", label: t("System default") }]),
      ...list.map((d, i) => ({ id: d.deviceId, label: d.label || t(kind === "audioinput" ? "Microphone {n}" : "Speakers {n}", { n: i + 1 }) })),
    ];
  }

  // A saved device that's been unplugged shows as the default, which is what gets used.
  function selected(kind: AudioDeviceKind) {
    const saved = store.devices[kind];
    return saved && options(kind).some((o) => o.id === saved) ? saved : "default";
  }

  const NOISE_LEVELS: { id: NoiseSuppression; label: string; hint: string }[] = [
    { id: "strong", label: "Strong", hint: "Also takes out keyboards, clicks and voices in the background, adapting as the noise around you changes." },
    { id: "standard", label: "Standard", hint: "Takes out steady noise, like fans and hum." },
    { id: "off", label: "Off", hint: "Sends your microphone as it is, for music or a studio mic." },
  ];
  // Strong needs audio worklets; without them it falls back to standard, so that's what shows.
  const noiseLevels = NOISE_LEVELS.filter((l) => l.id !== "strong" || canSuppressNoise);
  const noiseLevel = $derived(noiseLevels.find((l) => l.id === store.noiseSuppression) ?? NOISE_LEVELS[1]);
</script>

<svelte:window onkeydowncapture={onRecordKey} onmousedowncapture={onRecordKey} onpaste={(e) => usePhoto(pastedFile(e, isImage))} />

<Modal title={t("User settings")} onclose={() => (recording ? stopRecording() : onclose())}>
  <section>
    <h3>{t("Profile")}</h3>
    <div class="profile">
      <div class="big-avatar"><UserAvatar name={store.me?.name ?? ""} src={store.me?.avatar} /></div>
      <div class="photo-actions">
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden bind:this={photoInput} onchange={(e) => usePhoto(chosenFile(e))} />
        <button class="primary" type="button" disabled={busy} onclick={() => photoInput?.click()}>{t("Change photo")}</button>
        <button class="link" type="button" disabled={busy} onclick={() => run(store.resetAvatar())}>{t("Use my PocketID photo")}</button>
        <span class="hint">{t("or paste a picture")}</span>
      </div>
    </div>
    <form class="row" onsubmit={saveName}>
      <label class="field">
        <span>{t("Display name")}</span>
        <input bind:value={name} maxlength="32" />
      </label>
      <button class="primary" type="submit" disabled={busy || !name.trim() || name.trim() === store.me?.name}>{t("Save")}</button>
    </form>
    <button class="link" type="button" disabled={busy} onclick={() => run(store.updateName(""))}>{t("Use my PocketID name")}</button>
    {#if profileError}<p class="error">{profileError}</p>{/if}
  </section>

  <section>
    <label class="field">
      <span>{t("Language")}</span>
      <select value={i18n.lang} onchange={(e) => setLang(e.currentTarget.value as Lang)}>
        {#each LANGUAGES as l (l.id)}
          <option value={l.id}>{l.name}</option>
        {/each}
      </select>
    </label>
  </section>

  <section>
    <h3>{t("Keybinds")}</h3>
    <div class="modes" role="radiogroup" aria-label={t("Input mode")}>
      <label><input type="radio" name="mode" checked={!store.keybinds.pushToTalk} onchange={() => store.setKeybinds({ ...store.keybinds, pushToTalk: false })} /> {t("Voice activity")}</label>
      <label><input type="radio" name="mode" checked={store.keybinds.pushToTalk} onchange={() => store.setKeybinds({ ...store.keybinds, pushToTalk: true })} /> {t("Push to talk")}</label>
    </div>
    {#if store.keybinds.pushToTalk && !store.keybinds.binds.pushToTalk}
      <p class="error">{t("Pick a push-to-talk key below: until then your microphone stays silent.")}</p>
    {/if}
    <ul class="binds">
      {#each KEYBIND_ROWS as row (row.action)}
        {@const bind = store.keybinds.binds[row.action]}
        <li>
          <span class="bind-name">{t(row.label)}</span>
          <kbd class:recording={recording === row.action}>
            {recording === row.action ? t("Press a key or mouse button…") : bind ? keybindLabel(bind) : t("Not set")}
          </kbd>
          <button class="link" type="button" onclick={() => startRecording(row.action)}>{t("Change")}</button>
          {#if bind}<button class="link" type="button" onclick={() => setBind(row.action, null)}>{t("Clear")}</button>{/if}
        </li>
      {/each}
    </ul>
    <p class="hint">
      {t(systemWide.on
        ? "These also work while another app is in front. The app takes over the key everywhere, so for push-to-talk pick one you don't type with (like F13 or a Ctrl combination)."
        : isDesktop
          ? "These work while Gumcord is focused: this system doesn't let apps take keys system-wide (Wayland)."
          : "In the browser these work while Gumcord's tab is focused; the desktop app also takes them system-wide.")}
    </p>
  </section>

  <section>
    <h3>{t("Voice")}</h3>
    <label class="field">
      <span>{t("Microphone")}</span>
      <select value={selected("audioinput")} onchange={(e) => store.setDevice("audioinput", e.currentTarget.value)}>
        {#each options("audioinput") as o (o.id)}
          <option value={o.id}>{o.label}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span>{t("Noise suppression")}</span>
      <select value={noiseLevel.id} onchange={(e) => store.setNoiseSuppression(e.currentTarget.value as NoiseSuppression)}>
        {#each noiseLevels as l (l.id)}
          <option value={l.id}>{t(l.label)}</option>
        {/each}
      </select>
    </label>
    <p class="hint">{t(noiseLevel.hint)}</p>

    {#if noiseLevel.id === "strong"}
      {@const percent = Math.round(store.noiseStrength * 100)}
      <label class="strength">
        <span>{t("Strength")}</span>
        <input
          type="range"
          min="0"
          max="100"
          value={percent}
          oninput={(e) => store.setNoiseStrength(Number(e.currentTarget.value) / 100)}
        />
        <span class="pct">{percent}%</span>
      </label>
      <p class="hint">{t("Turn it down if your voice comes through choppy or robotic.")}</p>
    {/if}

    {#if canPickOutput}
      <label class="field">
        <span>{t("Speakers")}</span>
        <select value={selected("audiooutput")} onchange={(e) => store.setDevice("audiooutput", e.currentTarget.value)}>
          {#each options("audiooutput") as o (o.id)}
            <option value={o.id}>{o.label}</option>
          {/each}
        </select>
      </label>
    {:else}
      <p class="hint">{t("This browser always plays through the system's default speakers.")}</p>
    {/if}

    {#if !named}
      <p class="hint">
        {t("Your devices' names show up once Gumcord may use the microphone.")}
        <button class="link" type="button" onclick={allowMic}>{t("Allow")}</button>
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

  .modes {
    display: flex;
    gap: 20px;
    color: #c8cce8;
    font-size: 14px;
  }

  .modes label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .modes input { accent-color: #5b40c2; }

  .binds {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .binds li {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .binds .link { align-self: center; }

  .bind-name {
    flex: 1;
    color: #c8cce8;
    font-size: 14px;
  }

  kbd {
    flex-shrink: 0;
    min-width: 110px;
    white-space: nowrap;
    padding: 4px 8px;
    border: 1px solid #33365a;
    border-radius: 5px;
    background: #1a1b2e;
    color: #e4e6f5;
    font: 600 12px ui-monospace, monospace;
    text-align: center;
  }

  kbd.recording {
    border-color: #7c5cbf;
    color: #a78bfa;
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

  .strength {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #8a90b4;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .strength input {
    flex: 1;
    accent-color: #5b40c2;
  }

  .pct {
    width: 38px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  input:not([type="file"], [type="range"]) {
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
