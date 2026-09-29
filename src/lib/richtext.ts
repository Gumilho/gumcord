// A message's text as pieces to show: plain text and links.

export type Piece = { kind: "text"; text: string } | { kind: "link"; url: string; preview: boolean };

// Links written as <https://…> show without a preview, like Discord.
const LINK = /<(https?:\/\/[^\s<>]+)>|https?:\/\/[^\s<>]+/g;
const MAX_PREVIEWS = 3;

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

export function parseMessage(content: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  const text = (s: string) => {
    if (!s) return;
    const prev = pieces.at(-1);
    if (prev?.kind === "text") prev.text += s;
    else pieces.push({ kind: "text", text: s });
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

// The links to show previews for, first few only.
export function previewLinks(pieces: Piece[]) {
  const urls = pieces.flatMap((p) => (p.kind === "link" && p.preview ? [p.url] : []));
  return [...new Set(urls)].slice(0, MAX_PREVIEWS);
}
