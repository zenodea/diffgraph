import { describe, expect, it } from "vitest";
import { changedRange, highlightLines, languageFor, markRange } from "./highlight.ts";

describe("highlight", () => {
  it("keeps multi-line comments highlighted on every line", () => {
    const out = highlightLines(["/* one", "two */", "const x = 1;"], "javascript");
    expect(out).toHaveLength(3);
    expect(out[1]).toMatch(/^<span class="hljs-comment">two \*\/<\/span>$/);
    expect(out[2]).toContain("hljs-keyword");
  });

  it("escapes when there's no language", () => {
    expect(highlightLines(["<b>&"], null)).toEqual(["&lt;b&gt;&amp;"]);
  });

  it("finds the changed middle of a line", () => {
    expect(changedRange("return a + b;", "return a * b;")).toEqual({ a: [9, 10], b: [9, 10] });
    expect(changedRange("same", "same")).toBeNull();
  });

  it("marks visible chars across tags and entities", () => {
    expect(markRange('a<span class="k">b&lt;c</span>d', 1, 3)).toBe('a<span class="k"><mark class="w">b&lt;</mark>c</span>d');
  });

  it("maps file names to languages", () => {
    expect(languageFor("src/App.tsx")).toBe("typescript");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("notes.unknownext")).toBeNull();
  });
});
