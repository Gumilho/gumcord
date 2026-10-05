import { beforeEach, describe, expect, it, vi } from "vitest";

const setOutputDevice = vi.fn(async () => {});
vi.mock("./audio.ts", () => ({ setOutputDevice }));

// The preferences are read when the module loads, so each test loads a fresh copy.
async function load() {
  vi.resetModules();
  return import("./prefs.svelte.ts");
}

beforeEach(() => setOutputDevice.mockClear());

describe("loading saved settings", () => {
  it("uses the defaults when nothing is saved", async () => {
    const { prefs, DEFAULT_KEYBINDS } = await load();
    expect(prefs.noiseSuppression).toBe("strong");
    expect(prefs.noiseStrength).toBe(1);
    expect(prefs.soundboardVolume).toBe(0.5);
    expect(prefs.showMembers).toBe(true);
    expect(prefs.devices).toEqual({});
    expect(prefs.keybinds).toEqual(DEFAULT_KEYBINDS);
    expect(prefs.recordingKeybind).toBe(false);
  });

  it("restores what was saved", async () => {
    localStorage.setItem("gc_noise_suppression", "off");
    localStorage.setItem("gc_noise_strength", "0.25");
    localStorage.setItem("gc_soundboard_volume", "0.8");
    localStorage.setItem("gc_members", "0");
    localStorage.setItem("gc_devices", JSON.stringify({ audioinput: "mic-1" }));
    const { prefs } = await load();
    expect(prefs.noiseSuppression).toBe("off");
    expect(prefs.noiseStrength).toBe(0.25);
    expect(prefs.soundboardVolume).toBe(0.8);
    expect(prefs.showMembers).toBe(false);
    expect(prefs.devices).toEqual({ audioinput: "mic-1" });
  });

  it("falls back to the defaults for garbage", async () => {
    localStorage.setItem("gc_noise_suppression", "extreme");
    localStorage.setItem("gc_noise_strength", "loud");
    localStorage.setItem("gc_soundboard_volume", "NaN");
    localStorage.setItem("gc_keybinds", "{not json");
    localStorage.setItem("gc_devices", "{not json");
    const { prefs, DEFAULT_KEYBINDS } = await load();
    expect(prefs.noiseSuppression).toBe("strong");
    expect(prefs.noiseStrength).toBe(1);
    expect(prefs.soundboardVolume).toBe(0.5);
    expect(prefs.keybinds).toEqual(DEFAULT_KEYBINDS);
    expect(prefs.devices).toEqual({});
  });

  it("keeps volumes between 0 and 1", async () => {
    localStorage.setItem("gc_noise_strength", "7");
    localStorage.setItem("gc_soundboard_volume", "-3");
    const { prefs } = await load();
    expect(prefs.noiseStrength).toBe(1);
    expect(prefs.soundboardVolume).toBe(0);
  });

  it("fills in key bindings an older save didn't have", async () => {
    localStorage.setItem("gc_keybinds", JSON.stringify({ pushToTalk: true, binds: { toggleMute: null } }));
    const { prefs, DEFAULT_KEYBINDS } = await load();
    expect(prefs.keybinds.pushToTalk).toBe(true);
    expect(prefs.keybinds.binds.toggleMute).toBeNull();
    expect(prefs.keybinds.binds.toggleDeafen).toEqual(DEFAULT_KEYBINDS.binds.toggleDeafen);
  });

  it("points the speakers at the saved output device", async () => {
    localStorage.setItem("gc_devices", JSON.stringify({ audiooutput: "speakers-2" }));
    await load();
    expect(setOutputDevice).toHaveBeenCalledWith("speakers-2");
  });

  it("leaves the speakers alone when none was chosen", async () => {
    await load();
    expect(setOutputDevice).not.toHaveBeenCalled();
  });
});

describe("saving settings", () => {
  it("writes each change where the next load finds it", async () => {
    const { prefs } = await load();
    prefs.saveDevice("audioinput", "mic-9");
    prefs.saveDevice("audiooutput", "out-3");
    prefs.saveNoiseSuppression("standard");
    prefs.saveNoiseStrength(0.4);
    prefs.setSoundboardVolume(0.9);
    prefs.toggleMembers();
    prefs.saveKeybinds({ pushToTalk: true, binds: { toggleMute: null, toggleDeafen: null, pushToTalk: { code: "KeyV", ctrl: false, shift: false, alt: false, meta: false } } });

    const again = (await load()).prefs;
    expect(again.devices).toEqual({ audioinput: "mic-9", audiooutput: "out-3" });
    expect(again.noiseSuppression).toBe("standard");
    expect(again.noiseStrength).toBe(0.4);
    expect(again.soundboardVolume).toBe(0.9);
    expect(again.showMembers).toBe(false);
    expect(again.keybinds.binds.pushToTalk?.code).toBe("KeyV");
  });

  it("toggles the member list both ways", async () => {
    const { prefs } = await load();
    prefs.toggleMembers();
    expect(prefs.showMembers).toBe(false);
    prefs.toggleMembers();
    expect(prefs.showMembers).toBe(true);
    expect(localStorage.getItem("gc_members")).toBe("1");
  });
});
