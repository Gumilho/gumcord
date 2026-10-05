import { describe, expect, it } from "vitest";
import { onlyEmotes, parseMessage, previewLinks } from "./richtext.ts";

const emote = (name: string) => ({ id: 1, name, url: `/files/emote-${name}.png`, created_by: 1 });
const emotes = new Map([["kappa", emote("Kappa")], ["pog", emote("Pog")]]);
const parse = (s: string) => parseMessage(s, emotes);

describe("parseMessage", () => {
  it("leaves plain text alone", () => {
    expect(parse("just words")).toEqual([{ kind: "text", text: "just words" }]);
    expect(parse("")).toEqual([]);
  });

  it("finds links, with the sentence's punctuation left out of them", () => {
    expect(parse("see https://x.com/a.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", url: "https://x.com/a", preview: true },
      { kind: "text", text: "." },
    ]);
    expect(parse("wow https://x.com/a?b=1!!")[1]).toMatchObject({ url: "https://x.com/a?b=1" });
  });

  it("drops a closing bracket the link didn't open, but keeps its own", () => {
    expect(parse("(https://x.com)")).toEqual([
      { kind: "text", text: "(" },
      { kind: "link", url: "https://x.com", preview: true },
      { kind: "text", text: ")" },
    ]);
    expect(parse("https://en.wikipedia.org/wiki/Foo_(bar)")[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/Foo_(bar)" });
  });

  it("shows <links> without a preview, and without the brackets", () => {
    expect(parse("<https://x.com/a> ok")).toEqual([
      { kind: "link", url: "https://x.com/a", preview: false },
      { kind: "text", text: " ok" },
    ]);
  });

  it("only treats http(s) as a link", () => {
    expect(parse("javascript:alert(1) and ftp://x.com")).toEqual([{ kind: "text", text: "javascript:alert(1) and ftp://x.com" }]);
  });

  it("shows the server's emotes, whatever the case, and leaves unknown ones as text", () => {
    expect(parse("hi :kappa: :Pog: :nope:")).toEqual([
      { kind: "text", text: "hi " },
      { kind: "emote", emote: emote("Kappa") },
      { kind: "text", text: " " },
      { kind: "emote", emote: emote("Pog") },
      { kind: "text", text: " :nope:" },
    ]);
  });

  it("doesn't look for emotes inside links", () => {
    const pieces = parse("https://x.com/:kappa:/a");
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ kind: "link" });
  });
});

describe("onlyEmotes", () => {
  it("is true for a message of nothing but emotes", () => {
    expect(onlyEmotes(parse(":kappa:"))).toBe(true);
    expect(onlyEmotes(parse(":kappa: :pog:  :kappa:"))).toBe(true);
  });

  it("is false with any other text, or none at all", () => {
    expect(onlyEmotes(parse("hello :kappa:"))).toBe(false);
    expect(onlyEmotes(parse("hello"))).toBe(false);
    expect(onlyEmotes([])).toBe(false);
  });

  it("is false past 27 emotes", () => {
    expect(onlyEmotes(parse(Array(27).fill(":kappa:").join(" ")))).toBe(true);
    expect(onlyEmotes(parse(Array(28).fill(":kappa:").join(" ")))).toBe(false);
  });
});

describe("previewLinks", () => {
  it("lists each link once, up to three, and skips <quiet> ones", () => {
    const pieces = parse("https://a.com https://a.com <https://q.com> https://b.com https://c.com https://d.com");
    expect(previewLinks(pieces)).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  });
});
