// A message's text as pieces to show: plain text, links and the server's emotes.
import type { Emote } from "./store.svelte.ts";

export type Piece =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; preview: boolean }
  | { kind: "emote"; emote: Emote };

// Links written as <https://…> show without a preview, like Discord.
const LINK = /<(https?:\/\/[^\s<>]+)>|https?:\/\/[^\s<>]+/g;
const MAX_PREVIEWS = 3;
const EMOTE = /:([A-Za-z0-9_]{2,32}):/g;
// A message of only emotes shows them big, up to this many.
const MAX_JUMBO = 27;

// Punctuation after a link belongs to the sentence ("see https://x.com/a."), and so does a closing
// bracket the link didn't open ("(https://x.com)"); "https://en.wikipedia.org/wiki/Foo_(bar)" keeps its own.
function trimLink(url: string) {
  for (;;) {
    const last = url.at(-1)!;
    const open = { ")": "(", "]": "[", "}": "{" }[last];
    if (/[.,:;!?'"*_~]/.test(last) || (open && url.split(open).length <= url.split(last).length - 1)) url = url.slice(0, -1);
    else return url;
  }
}

// emotes: the server's, by lowercase name. Unknown :names: stay text.
export function parseMessage(content: string, emotes: ReadonlyMap<string, Emote>): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  const plain = (s: string) => {
    if (!s) return;
    const prev = pieces.at(-1);
    if (prev?.kind === "text") prev.text += s;
    else pieces.push({ kind: "text", text: s });
  };
  const text = (s: string) => {
    let from = 0;
    for (const m of s.matchAll(EMOTE)) {
      const emote = emotes.get(m[1].toLowerCase());
      if (!emote) continue;
      plain(s.slice(from, m.index));
      pieces.push({ kind: "emote", emote });
      from = m.index + m[0].length;
    }
    plain(s.slice(from));
  };
  for (const m of content.matchAll(LINK)) {
    const quiet = m[1] !== undefined;
    const url = quiet ? m[1] : trimLink(m[0]);
    text(content.slice(at, m.index));
    pieces.push({ kind: "link", url, preview: !quiet });
    at = m.index + (quiet ? m[0].length : url.length);
  }
  text(content.slice(at));
  return pieces;
}

export function onlyEmotes(pieces: Piece[]) {
  const emotes = pieces.filter((p) => p.kind === "emote").length;
  return emotes > 0 && emotes <= MAX_JUMBO && pieces.every((p) => p.kind === "emote" || (p.kind === "text" && !p.text.trim()));
}

// The links to show previews for, first few only.
export function previewLinks(pieces: Piece[]) {
  const urls = pieces.flatMap((p) => (p.kind === "link" && p.preview ? [p.url] : []));
  return [...new Set(urls)].slice(0, MAX_PREVIEWS);
}
