// Settings kept on this device: audio devices, noise suppression, keyboard shortcuts and a few
// display choices. Nothing here talks to the server, or to a call: changing a setting that affects
// a call goes through voice.svelte.ts, which saves it here and applies it.
import { setOutputDevice } from "./audio.ts";

// A key plus the modifiers held with it. code is KeyboardEvent.code, e.g. "KeyM" or "F13".
export interface Keybind { code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; }
export type KeybindAction = "toggleMute" | "toggleDeafen" | "pushToTalk";
export interface KeybindPrefs { pushToTalk: boolean; binds: Record<KeybindAction, Keybind | null>; }

// Chosen microphone and speakers. Missing means the system default.
export type AudioDeviceKind = "audioinput" | "audiooutput";
export type DevicePrefs = Partial<Record<AudioDeviceKind, string>>;

// How much background noise is taken out of your microphone. "standard" is the browser's own
// suppression, "strong" adds RNNoise on top (see noise.ts), "off" sends it as is.
export type NoiseSuppression = "strong" | "standard" | "off";

const MEMBERS_KEY        = "gc_members";
const KEYBINDS_KEY       = "gc_keybinds";
const DEVICES_KEY        = "gc_devices";
const NOISE_KEY          = "gc_noise_suppression";
const NOISE_STRENGTH_KEY = "gc_noise_strength"; // how hard strong suppression works, from 0 to 1
const SOUND_VOLUME_KEY   = "gc_soundboard_volume";

export const DEFAULT_KEYBINDS: KeybindPrefs = {
  pushToTalk: false,
  binds: {
    toggleMute:   { code: "KeyM", ctrl: true, shift: true, alt: false, meta: false },
    toggleDeafen: { code: "KeyD", ctrl: true, shift: true, alt: false, meta: false },
    pushToTalk:   null,
  },
};

// A saved number from 0 to 1, or the default when there's none or it's garbage.
function loadFraction(key: string, fallback: number) {
  const v = Number(localStorage.getItem(key) ?? fallback);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : fallback;
}

export const loadSoundboardVolume = () => loadFraction(SOUND_VOLUME_KEY, 0.5);
export const loadNoiseStrength    = () => loadFraction(NOISE_STRENGTH_KEY, 1);

export function loadNoiseSuppression(): NoiseSuppression {
  const saved = localStorage.getItem(NOISE_KEY);
  return saved === "standard" || saved === "off" ? saved : "strong";
}

export function loadKeybinds(): KeybindPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEYBINDS_KEY) ?? "null");
    return saved ? { ...DEFAULT_KEYBINDS, ...saved, binds: { ...DEFAULT_KEYBINDS.binds, ...saved.binds } } : DEFAULT_KEYBINDS;
  } catch {
    return DEFAULT_KEYBINDS;
  }
}

export function loadDevicePrefs(): DevicePrefs {
  try {
    return JSON.parse(localStorage.getItem(DEVICES_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

class Prefs {
  devices:          DevicePrefs      = $state(loadDevicePrefs());
  noiseSuppression: NoiseSuppression = $state(loadNoiseSuppression());
  noiseStrength                      = $state(loadNoiseStrength());
  keybinds:         KeybindPrefs     = $state(loadKeybinds());
  // While the settings dialog records a new key, shortcuts are off.
  recordingKeybind                   = $state(false);
  // Whether the member list is shown.
  showMembers                        = $state(localStorage.getItem(MEMBERS_KEY) !== "0");
  soundboardVolume                   = $state(loadSoundboardVolume());

  constructor() {
    // Applied to the shared audio context once it exists.
    if (this.devices.audiooutput) void setOutputDevice(this.devices.audiooutput);
  }

  saveDevice(kind: AudioDeviceKind, deviceId: string) {
    this.devices = { ...this.devices, [kind]: deviceId };
    localStorage.setItem(DEVICES_KEY, JSON.stringify(this.devices));
  }

  saveNoiseSuppression(level: NoiseSuppression) {
    this.noiseSuppression = level;
    localStorage.setItem(NOISE_KEY, level);
  }

  saveNoiseStrength(strength: number) {
    this.noiseStrength = strength;
    localStorage.setItem(NOISE_STRENGTH_KEY, String(strength));
  }

  saveKeybinds(keybinds: KeybindPrefs) {
    this.keybinds = keybinds;
    localStorage.setItem(KEYBINDS_KEY, JSON.stringify(keybinds));
  }

  setSoundboardVolume(volume: number) {
    this.soundboardVolume = volume;
    localStorage.setItem(SOUND_VOLUME_KEY, String(volume));
  }

  toggleMembers() {
    this.showMembers = !this.showMembers;
    localStorage.setItem(MEMBERS_KEY, this.showMembers ? "1" : "0");
  }
}

export const prefs = new Prefs();
