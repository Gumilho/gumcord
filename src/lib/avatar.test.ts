import { describe, expect, it } from "vitest";
import { hue, initial, initials } from "./avatar.ts";

describe("avatar helpers", () => {
  it("initial is the first letter, upper-cased", () => {
    expect(initial("alice")).toBe("A");
    expect(initial("élan")).toBe("É");
    expect(initial("")).toBe("");
  });

  it("hue is stable and within the colour wheel", () => {
    expect(hue("alice")).toBe(hue("alice"));
    expect(hue("alice")).not.toBe(hue("bob"));
    for (const name of ["", "a", "alice", "🙂 emoji", "x".repeat(500)]) {
      expect(hue(name)).toBeGreaterThanOrEqual(0);
      expect(hue(name)).toBeLessThan(360);
    }
  });

  it("initials are up to two letters from the first two words", () => {
    expect(initials("Best Friends")).toBe("BF");
    expect(initials("Gumcord")).toBe("G");
    expect(initials("  the   big   club ")).toBe("TB");
    expect(initials("")).toBe("?");
    expect(initials("🙂 fun")).toBe("🙂F");
  });
});
