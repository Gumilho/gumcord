// On a phone-sized screen the app is two panes: navigation (servers, channels and you) underneath,
// and the open chat or call sliding over it. Picking a channel slides the panel in; the back button
// slides it away. It also follows a finger dragged sideways anywhere.

const NARROW = "(max-width: 768px)";
const query = matchMedia(NARROW);

export const mobile = $state({
  narrow: query.matches,
  pane: "main" as "nav" | "main",
  // While a finger drags the panel: how far it is from the left edge, in pixels.
  drag: null as number | null,
});
query.addEventListener("change", (e) => (mobile.narrow = e.matches));

export function showNav() {
  mobile.pane = "nav";
}

export function showMain() {
  mobile.pane = "main";
}

// ── Dragging the panel ──

// A touch becomes a drag once it has clearly moved sideways; moving up or down first is scrolling.
const LOCK_PX = 10;
// Let go while moving this fast (px per ms) and the panel goes that way, however far it got. A
// finger that stopped this long before lifting wasn't moving (a still finger sends no moves).
const FLICK_SPEED = 0.35;
const STILL_MS = 80;

let touch: {
  x: number; y: number; // where it started
  base: number; // where the panel was then
  width: number;
  axis: "x" | "y" | null;
  last: { x: number; t: number }; // the last two moves, for the speed on release
  prev: { x: number; t: number };
} | null = null;

// canOpen: whether there's a chat or call to slide back in from the channel list.
export function dragStart(e: TouchEvent, canOpen: boolean) {
  touch = null;
  if (!mobile.narrow || e.touches.length !== 1) return;
  // Fields keep their own sideways gestures (moving the caret), and the call's strip scrolls sideways.
  if ((e.target as Element).closest("input, textarea, select, .strip")) return;
  if (mobile.pane === "nav" && !canOpen) return;
  const { clientX: x, clientY: y } = e.touches[0];
  const width = innerWidth;
  const now = { x, t: e.timeStamp };
  touch = { x, y, base: mobile.pane === "nav" ? width : 0, width, axis: null, last: now, prev: now };
}

export function dragMove(e: TouchEvent) {
  if (!touch) return;
  const { clientX: x, clientY: y } = e.touches[0];
  const dx = x - touch.x;
  if (!touch.axis) {
    if (Math.max(Math.abs(dx), Math.abs(y - touch.y)) < LOCK_PX) return;
    touch.axis = Math.abs(dx) > Math.abs(y - touch.y) ? "x" : "y";
  }
  if (touch.axis !== "x") return;
  touch.prev = touch.last;
  touch.last = { x, t: e.timeStamp };
  mobile.drag = Math.min(touch.width, Math.max(0, touch.base + dx));
}

// Settles on a side: the way it was flicked, or else the nearer one. The panel animates from
// where the finger left it.
export function dragEnd(e: TouchEvent) {
  const t = touch;
  touch = null;
  if (!t || t.axis !== "x" || mobile.drag === null) return;
  const dt = t.last.t - t.prev.t;
  const moving = e.timeStamp - t.last.t < STILL_MS;
  const speed = moving && dt > 0 ? (t.last.x - t.prev.x) / dt : 0;
  const toNav = Math.abs(speed) > FLICK_SPEED ? speed > 0 : mobile.drag > t.width / 2;
  mobile.pane = toNav ? "nav" : "main";
  mobile.drag = null;
}
