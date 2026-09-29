// On a phone-sized screen the app is two panes: navigation (servers, channels and you) and the
// open chat or call. Picking a channel opens it; the back button or a swipe right returns.

const NARROW = "(max-width: 768px)";
const query = matchMedia(NARROW);

export const mobile = $state({ narrow: query.matches, pane: "main" as "nav" | "main" });
query.addEventListener("change", (e) => (mobile.narrow = e.matches));

export function showNav() {
  mobile.pane = "nav";
}

export function showMain() {
  mobile.pane = "main";
}

// A quick, mostly sideways swipe: +1 to the right, -1 to the left, 0 for anything else (scrolling,
// taps, sliders, the message box, the call's scrolling strip). Touches inside an embedded video
// player never reach the page, so those don't count either.
const MIN_SWIPE = 60;
const MAX_SWIPE_MS = 600;
let start: { x: number; y: number; t: number } | null = null;

export function swipeStart(e: TouchEvent) {
  const target = e.target as Element;
  const ignore = e.touches.length !== 1 || target.closest("input, textarea, select, .strip");
  start = ignore ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}

export function swipeEnd(e: TouchEvent): -1 | 0 | 1 {
  const from = start;
  start = null;
  if (!from || !mobile.narrow || Date.now() - from.t > MAX_SWIPE_MS) return 0;
  const dx = e.changedTouches[0].clientX - from.x;
  const dy = e.changedTouches[0].clientY - from.y;
  if (Math.abs(dx) < MIN_SWIPE || Math.abs(dy) > Math.abs(dx) / 2) return 0;
  return dx > 0 ? 1 : -1;
}
