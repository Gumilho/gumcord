// Link previews, from the server (which reads the page and passes its picture through).

export interface Embed {
  url: string;
  kind: "page" | "image" | "video";
  site?: string;
  title?: string;
  description?: string;
  image?: string;
  large?: boolean;
  color?: string;
  video?: string; // a player to embed (YouTube, Vimeo), or for kind "video" the file
}

// One request per link while the app is open; the server keeps them for hours as well.
const cache = new Map<string, Promise<Embed | null>>();

export function getEmbed(url: string): Promise<Embed | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(`/api/embed?url=${encodeURIComponent(url)}`)
      .then((r) => {
        if (r.status === 200) return r.json() as Promise<Embed>;
        if (r.status !== 204) cache.delete(url); // busy (too many at once): try again next time it's shown
        return null;
      })
      .catch(() => {
        cache.delete(url); // offline for a moment: try again next time it's shown
        return null;
      });
    cache.set(url, p);
  }
  return p;
}
