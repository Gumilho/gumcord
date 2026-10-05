import { afterEach, describe, expect, it } from "vitest";
import { dialogFocus, menuKeys, tabbables } from "./focus.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

// Builds some page: an opener button, and a dialog next to it.
function page(dialog: string) {
  document.body.innerHTML = `<button id="opener">open</button><div id="dialog">${dialog}</div>`;
  const opener = document.getElementById("opener") as HTMLButtonElement;
  const root = document.getElementById("dialog") as HTMLElement;
  opener.focus();
  return { opener, root };
}

const press = (el: Element, key: string, shiftKey = false) => {
  const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe("tabbables", () => {
  it("finds what Tab reaches, in order, and skips what it can't", () => {
    const { root } = page(`
      <input id="a"><button id="b">b</button><button id="c" disabled>c</button>
      <a id="d" href="#x">d</a><a id="skip">no href</a><input id="e" type="hidden">
      <div id="f" tabindex="0">f</div><div id="g" tabindex="-1">g</div>
      <div hidden><button id="h">h</button></div><div inert><button id="i">i</button></div>
      <select id="j"></select><textarea id="k"></textarea>`);
    expect(tabbables(root).map((el) => el.id)).toEqual(["a", "b", "d", "f", "j", "k"]);
  });
});

describe("tabbables and radio buttons", () => {
  it("counts a group of radios once: the chosen one, or the first", () => {
    const { root } = page(`
      <input id="a">
      <input type="radio" name="mode" id="r1"><input type="radio" name="mode" id="r2" checked><input type="radio" name="mode" id="r3">
      <input type="radio" name="size" id="s1"><input type="radio" name="size" id="s2">
      <input type="radio" id="loner1"><input type="radio" id="loner2">
      <button id="z">z</button>`);
    expect(tabbables(root).map((el) => el.id)).toEqual(["a", "r2", "s1", "loner1", "loner2", "z"]);
  });

  it("keeps same-named radios in different forms apart", () => {
    const { root } = page(`
      <form><input type="radio" name="m" id="f1a"><input type="radio" name="m" id="f1b"></form>
      <form><input type="radio" name="m" id="f2a"><input type="radio" name="m" id="f2b" checked></form>`);
    expect(tabbables(root).map((el) => el.id)).toEqual(["f1a", "f2b"]);
  });
});

describe("dialogFocus", () => {
  it("moves focus to the first thing in the dialog", () => {
    const { root } = page(`<button id="a">a</button><button id="b">b</button>`);
    dialogFocus(root);
    expect(document.activeElement?.id).toBe("a");
  });

  it("or to the one asked for", () => {
    const { root } = page(`<button id="a">a</button><input id="search">`);
    dialogFocus(root, { first: "#search" });
    expect(document.activeElement?.id).toBe("search");
  });

  it("focuses the dialog itself when there's nothing in it to focus", () => {
    const { root } = page(`<p>just text</p>`);
    dialogFocus(root);
    expect(document.activeElement).toBe(root);
  });

  it("keeps Tab going round inside, in both directions", () => {
    const { root, opener } = page(`<button id="a">a</button><button id="b">b</button><button id="c">c</button>`);
    dialogFocus(root);
    const at = () => document.activeElement?.id;

    document.getElementById("c")!.focus();
    expect(press(root, "Tab").defaultPrevented).toBe(true);
    expect(at()).toBe("a");

    expect(press(root, "Tab", true).defaultPrevented).toBe(true); // backwards from the first
    expect(at()).toBe("c");

    document.getElementById("b")!.focus();
    expect(press(root, "Tab").defaultPrevented).toBe(false); // in the middle the browser does it
    expect(opener.isConnected).toBe(true);
  });

  it("wraps correctly when the last thing in the dialog is a radio Tab skips over", () => {
    const { root } = page(`
      <button id="a">a</button>
      <input type="radio" name="m" id="r1" checked><input type="radio" name="m" id="r2">`);
    dialogFocus(root);
    document.getElementById("r1")!.focus(); // where Tab really ends up: r2 is never a stop
    expect(press(root, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("brings focus back if the browser took it out anyway", async () => {
    const { root, opener } = page(`<button id="a">a</button><button id="b">b</button><button id="c">c</button>`);
    dialogFocus(root);
    document.getElementById("b")!.focus();
    press(root, "Tab"); // in the middle: left to the browser...
    opener.focus(); // ...which, here, wrongly lands outside
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement?.id).toBe("a");
  });

  it("lets Tab leave a pop-up that isn't a trap, but still takes and gives back focus", () => {
    const { root, opener } = page(`<button id="a">a</button>`);
    const action = dialogFocus(root, { trap: false });
    expect(document.activeElement?.id).toBe("a");
    expect(press(root, "Tab").defaultPrevented).toBe(false);
    root.remove();
    action.destroy();
    expect(document.activeElement).toBe(opener);
  });

  it("brings stray focus back in", () => {
    const { root, opener } = page(`<button id="a">a</button><button id="b">b</button>`);
    dialogFocus(root);
    opener.focus(); // got out some other way
    press(root, "Tab");
    expect(document.activeElement?.id).toBe("a");
    opener.focus();
    press(root, "Tab", true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("holds focus on a dialog with nothing to tab to", () => {
    const { root } = page(`<p>text</p>`);
    dialogFocus(root);
    expect(press(root, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(root);
  });

  it("puts focus back on what opened it when it closes", () => {
    const { root, opener } = page(`<button id="a">a</button>`);
    const action = dialogFocus(root);
    expect(document.activeElement?.id).toBe("a");
    root.remove();
    action.destroy();
    expect(document.activeElement).toBe(opener);
  });

  it("doesn't, if focus has since been moved elsewhere on purpose", () => {
    document.body.innerHTML = `<button id="opener">o</button><button id="other">x</button><div id="dialog"><button id="a">a</button></div>`;
    document.getElementById("opener")!.focus();
    const root = document.getElementById("dialog")!;
    const action = dialogFocus(root);
    document.getElementById("other")!.focus();
    action.destroy();
    expect(document.activeElement?.id).toBe("other");
  });

  it("doesn't, if what opened it is gone", () => {
    const { root, opener } = page(`<button id="a">a</button>`);
    const action = dialogFocus(root);
    opener.remove();
    root.remove();
    action.destroy();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("menuKeys", () => {
  function menu() {
    const { root } = page(`
      <button role="menuitem" id="a">a</button>
      <button role="menuitemcheckbox" id="b">b</button>
      <button role="menuitem" id="c" disabled>c</button>
      <button role="menuitem" id="d">d</button>
      <button id="x">not an item</button>`);
    menuKeys(root);
    document.getElementById("a")!.focus();
    return root;
  }
  const at = () => document.activeElement?.id;

  it("moves down and up through the items, skipping disabled ones, and wraps", () => {
    const root = menu();
    expect(press(root, "ArrowDown").defaultPrevented).toBe(true);
    expect(at()).toBe("b");
    press(root, "ArrowDown");
    expect(at()).toBe("d");
    press(root, "ArrowDown");
    expect(at()).toBe("a");
    press(root, "ArrowUp");
    expect(at()).toBe("d");
    press(root, "ArrowUp");
    expect(at()).toBe("b");
  });

  it("jumps to the ends", () => {
    const root = menu();
    press(root, "End");
    expect(at()).toBe("d");
    press(root, "Home");
    expect(at()).toBe("a");
  });

  it("starts from the first or last when focus isn't on an item", () => {
    const root = menu();
    document.getElementById("x")!.focus();
    press(root, "ArrowDown");
    expect(at()).toBe("a");
    document.getElementById("x")!.focus();
    press(root, "ArrowUp");
    expect(at()).toBe("d");
  });

  it("leaves other keys alone", () => {
    const root = menu();
    expect(press(root, "a").defaultPrevented).toBe(false);
    expect(press(root, "Enter").defaultPrevented).toBe(false);
    expect(at()).toBe("a");
  });
});
