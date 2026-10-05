// Keyboard focus for dialogs, pop-ups and menus, as actions: `use:dialogFocus` and `use:menuKeys`.

// What Tab can land on. Whether it's shown can't be asked of an element without laying it out, so
// hidden things are the ones that say so: `hidden`, `inert`, or inside something that does.
const TABBABLE = [
  "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
  "[tabindex]", "[contenteditable=true]",
].join(",");

export function tabbables(root: HTMLElement): HTMLElement[] {
  const stops = [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) =>
    !el.matches(":disabled, [tabindex='-1']") && !el.closest("[hidden], [inert]"));
  // A group of radio buttons is one stop for Tab (the arrow keys move within it): the chosen one, or
  // the first if none is. Counting them all would put the "last" stop somewhere Tab never goes.
  const chosen = new Map<string, HTMLInputElement | undefined>();
  const groupOf = (el: HTMLInputElement) => `${el.form ? [...document.forms].indexOf(el.form) : -1}:${el.name}`;
  for (const el of stops) {
    if (el instanceof HTMLInputElement && el.type === "radio" && el.name) {
      const key = groupOf(el);
      const current = chosen.get(key);
      if (!current || (el.checked && !current.checked)) chosen.set(key, el);
    }
  }
  return stops.filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && el.name) || chosen.get(groupOf(el)) === el);
}

// Moves focus into the pop-up when it opens (to `first`, a selector, or else its first tabbable thing),
// keeps Tab and Shift+Tab going round inside it, and puts focus back where it was when it closes.
// A pop-up that isn't modal, which you can click away from, says `trap: false`: it still takes and
// gives back focus, but Tab may leave.
export function dialogFocus(node: HTMLElement, options: { first?: string; trap?: boolean } = {}) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const target = (options.first ? node.querySelector<HTMLElement>(options.first) : null) ?? tabbables(node)[0] ?? node;
  if (target === node && !node.hasAttribute("tabindex")) node.tabIndex = -1;
  target.focus();

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const items = tabbables(node);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0], last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !node.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !node.contains(at))) {
      e.preventDefault();
      first.focus();
    } else {
      // The browser moves focus; if that took it out anyway (a stop this list didn't know about),
      // it comes back, to the end it should have wrapped to.
      setTimeout(() => {
        if (node.isConnected && !node.contains(document.activeElement)) (e.shiftKey ? last : first).focus();
      }, 0);
    }
  }
  const trap = options.trap ?? true;
  if (trap) node.addEventListener("keydown", onKeydown);

  return {
    destroy() {
      if (trap) node.removeEventListener("keydown", onKeydown);
      // Not if the thing that opened it is gone (a menu item that was just chosen), or focus has
      // already moved on to something else on purpose.
      if (opener?.isConnected && (document.activeElement === document.body || node.contains(document.activeElement))) {
        opener.focus();
      }
    },
  };
}

// Arrow keys move through a menu's items (role="menuitem", "menuitemcheckbox" or "menuitemradio"), wrapping round.
export function menuKeys(node: HTMLElement) {
  function onKeydown(e: KeyboardEvent) {
    const items = [...node.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)")];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (e.key) {
      case "ArrowDown": next = (at + 1) % items.length; break;
      case "ArrowUp": next = at <= 0 ? items.length - 1 : at - 1; break;
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      default: return;
    }
    e.preventDefault();
    items[next].focus();
  }
  node.addEventListener("keydown", onKeydown);
  return { destroy: () => node.removeEventListener("keydown", onKeydown) };
}
