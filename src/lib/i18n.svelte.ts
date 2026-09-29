// The app's language. Text is written in English in the code, t("…"), and looked up in the chosen
// language's dictionary; anything missing shows in English. {name} placeholders are filled from vars.
import { pt } from "./locales/pt.ts";

export type Lang = "en" | "pt";

// Each shown in its own language, so anyone can find theirs.
export const LANGUAGES: { id: Lang; name: string }[] = [
  { id: "en", name: "English" },
  { id: "pt", name: "Português" },
];

const LANG_KEY = "gc_lang";
const dictionaries: Record<Lang, Record<string, string>> = { en: {}, pt };

// Saved choice first, otherwise the browser's language.
function initialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "en" || saved === "pt") return saved;
  return navigator.language?.toLowerCase().startsWith("pt") ? "pt" : "en";
}

export const i18n = $state({ lang: initialLang() });
document.documentElement.lang = i18n.lang;

export function setLang(lang: Lang) {
  i18n.lang = lang;
  document.documentElement.lang = lang;
  localStorage.setItem(LANG_KEY, lang);
}

export function t(text: string, vars?: Record<string, string | number>) {
  const s = dictionaries[i18n.lang][text] ?? text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m)) : s;
}

// The server's error messages (English), in the chosen language. A couple carry names or numbers.
export function serverMessage(text: string) {
  let m = /^there's already an? (\w+) called (.+)$/.exec(text);
  if (m) return t("there's already a {thing} called {name}", { thing: t(m[1]), name: m[2] });
  m = /^a server can have up to (\d+) (\w+)$/.exec(text);
  if (m) return t("a server can have up to {count} {things}", { count: m[1], things: t(m[2]) });
  return t(text);
}
