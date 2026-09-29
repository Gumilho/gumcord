export function initial(name: string) {
  return name.charAt(0).toUpperCase();
}

// Stable per-user hue, so avatars and tiles are tellable apart without pictures.
export function hue(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

// Up to two letters for a server tile: "Best Friends" → "BF", "Gumcord" → "G".
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => [...w][0]?.toUpperCase() ?? "").join("") || "?";
}
