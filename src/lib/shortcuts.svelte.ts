import { isDesktop, store, type Keybind, type KeybindAction } from "./store.svelte.ts";

// Keyboard shortcuts for mute, deafen and push-to-talk. In a browser they work while Gumcord has
// focus; the desktop app also registers them system-wide, so they work while you're in a game.

const ACTIONS: KeybindAction[] = ["toggleMute", "toggleDeafen", "pushToTalk"];
const MODIFIERS = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

// Mouse buttons bind as "Mouse<button>" (1 middle, 3 back, 4 forward...). Left and right stay
// free: they're how you use the app.
const isMouse = (code: string) => code.startsWith("Mouse");
const bindableButton = (button: number) => button === 1 || button >= 3;

// The key or mouse button just pressed, as a binding. Modifiers on their own aren't one.
export function keybindFromEvent(e: KeyboardEvent | MouseEvent): Keybind | null {
  let code: string;
  if (e instanceof MouseEvent) {
    if (!bindableButton(e.button)) return null;
    code = `Mouse${e.button}`;
  } else {
    if (MODIFIERS.has(e.code)) return null;
    code = e.code;
  }
  return { code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
}

export function keybindLabel(b: Keybind) {
  const button = isMouse(b.code) ? Number(b.code.slice(5)) : -1;
  const key = button === 1 ? "Middle click" : button >= 0 ? `Mouse ${button + 1}` : b.code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ").replace(/^Arrow/, "") || b.code;
  return [b.ctrl && "Ctrl", b.shift && "Shift", b.alt && "Alt", b.meta && "Meta", key].filter(Boolean).join(" + ");
}

const matches = (b: Keybind | null, e: KeyboardEvent | MouseEvent): b is Keybind =>
  !!b && b.code === (e instanceof MouseEvent ? `Mouse${e.button}` : e.code) && b.ctrl === e.ctrlKey && b.shift === e.shiftKey && b.alt === e.altKey && b.meta === e.metaKey;

function typing(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function run(action: KeybindAction, pressed: boolean) {
  if (store.recordingKeybind || !store.room) return;
  if (action === "pushToTalk") {
    if (store.keybinds.pushToTalk) store.pushToTalk(pressed);
  } else if (pressed) {
    void (action === "toggleMute" ? store.toggleMute() : store.toggleDeafen());
  }
}

// ── Desktop: system-wide shortcuts through the Tauri shell ──

type Invoke = (cmd: string, args: object) => Promise<unknown>;
const tauriInvoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;
// Actions the shell registered; the window's own listener leaves those alone to avoid double toggles.
let global = new Set<string>();
// For settings: whether the keys work while other apps are in front.
export const systemWide = $state({ on: false });

// "ctrl+shift+KeyM", in the form the shell's global-hotkey parser reads.
function accelerator(b: Keybind) {
  return [b.ctrl && "control", b.shift && "shift", b.alt && "alt", b.meta && "super", b.code].filter(Boolean).join("+");
}

async function registerGlobal() {
  if (!isDesktop || !tauriInvoke) return;
  const shortcuts = ACTIONS.flatMap((action) => {
    const b = store.keybinds.binds[action];
    return b && !isMouse(b.code) ? [{ action, accelerator: accelerator(b) }] : [];
  });
  try {
    global = new Set((await tauriInvoke("set_shortcuts", { shortcuts })) as string[]);
    systemWide.on = true;
  } catch (err) {
    global = new Set(); // an older app, or no system shortcuts on this platform: keep in-window ones
    systemWide.on = false;
    console.warn("System-wide shortcuts unavailable:", err);
  }
}

// ── Setup ──

export function installShortcuts() {
  const down = (e: KeyboardEvent) => {
    for (const action of ACTIONS) {
      const b = store.keybinds.binds[action];
      if (!matches(b, e)) continue;
      if (typing(e) && !b.ctrl && !b.alt && !b.meta) return; // a plain key in a text field is typing
      e.preventDefault();
      if (global.has(action) || (e.repeat && action !== "pushToTalk")) return;
      run(action, true);
      return;
    }
  };
  const up = (e: KeyboardEvent) => {
    const b = store.keybinds.binds.pushToTalk;
    if (b && e.code === b.code && !global.has("pushToTalk")) run("pushToTalk", false);
  };
  // Letting go of the key in another window never reaches this one: don't stay on air.
  const blur = () => {
    if (!global.has("pushToTalk")) store.pushToTalk(false);
  };
  // Mouse buttons only work in the window: the shell can't take them system-wide.
  const mouseDown = (e: MouseEvent) => {
    if (!bindableButton(e.button)) return;
    for (const action of ACTIONS) {
      if (!matches(store.keybinds.binds[action], e)) continue;
      e.preventDefault(); // no autoscroll, no back/forward navigation
      run(action, true);
      return;
    }
  };
  const mouseUp = (e: MouseEvent) => {
    const b = store.keybinds.binds.pushToTalk;
    if (!bindableButton(e.button) || !b || b.code !== `Mouse${e.button}`) return;
    e.preventDefault();
    run("pushToTalk", false);
  };
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("mousedown", mouseDown);
  window.addEventListener("mouseup", mouseUp);
  window.addEventListener("blur", blur);

  // The shell calls this for system-wide shortcuts.
  (window as unknown as { gumcordShortcut?: (action: KeybindAction, state: string) => void }).gumcordShortcut =
    (action, state) => run(action, state === "pressed");
  const stopEffects = $effect.root(() => {
    $effect(() => {
      void JSON.stringify(store.keybinds); // re-register whenever a binding changes
      void registerGlobal();
    });
  });

  return () => {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
    window.removeEventListener("mousedown", mouseDown);
    window.removeEventListener("mouseup", mouseUp);
    window.removeEventListener("blur", blur);
    stopEffects();
  };
}
