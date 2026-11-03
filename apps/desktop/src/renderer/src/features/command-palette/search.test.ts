import { describe, expect, test } from "bun:test";
import { searchScore } from "./search";

describe("command search", () => {
  test("ranks exact names before prefixes and keywords", () => {
    const exact = searchScore("Settings", "", "settings");
    const prefix = searchScore("Settings overview", "", "settings");
    const partial = searchScore("Appearance settings", "", "settings");
    const keyword = searchScore("Preferences", "settings", "settings");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(keyword);
  });

  test("matches words across a thread title and its project", () => {
    expect(
      searchScore("Improve loading", "Design system", "design loading"),
    ).toBeGreaterThanOrEqual(0);
    expect(searchScore("Improve loading", "Design system", "design billing")).toBe(-1);
  });

  test("ignores case, surrounding whitespace, and accents", () => {
    expect(searchScore("Café redesign", "", "  CAFE  ")).toBeGreaterThanOrEqual(0);
    expect(searchScore("Preferences", "Café", "cafe")).toBeGreaterThanOrEqual(0);
    expect(searchScore("Settings", "", "   ")).toBe(0);
  });
});
