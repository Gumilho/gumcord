import type { Action } from "svelte/action";

// Rendered on <body> with fixed positioning so containers with overflow: hidden can't clip it.
export const tooltip: Action<HTMLElement, string> = (node, initial) => {
  let text = initial;
  let tip: HTMLDivElement | null = null;

  function show() {
    if (!text || tip) return;
    tip = document.createElement("div");
    tip.className = "gc-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = text;
    document.body.appendChild(tip);

    const r = node.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, r.left + r.width / 2 - t.width / 2),
      window.innerWidth - t.width - margin,
    );
    tip.style.left = `${left}px`;
    tip.style.top = `${r.top - t.height - 8}px`;
    tip.style.setProperty("--arrow-x", `${r.left + r.width / 2 - left}px`);
  }

  function hide() {
    tip?.remove();
    tip = null;
  }

  node.addEventListener("mouseenter", show);
  node.addEventListener("mouseleave", hide);
  node.addEventListener("focus", show);
  node.addEventListener("blur", hide);
  node.addEventListener("click", hide);

  return {
    update(next) {
      text = next;
      if (tip) tip.textContent = next;
    },
    destroy() {
      hide();
      node.removeEventListener("mouseenter", show);
      node.removeEventListener("mouseleave", hide);
      node.removeEventListener("focus", show);
      node.removeEventListener("blur", hide);
      node.removeEventListener("click", hide);
    },
  };
};
