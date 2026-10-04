import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./md.ts";

describe("renderMarkdown", () => {
  it("renders bold, inline code, lists and paragraphs", () => {
    expect(renderMarkdown("**No tests.**\n\nWhy: `x` <here>\n- a\n- b")).toBe(
      "<p><strong>No tests.</strong></p><p>Why: <code>x</code> &lt;here&gt;</p><ul><li>a</li><li>b</li></ul>",
    );
  });

  it("keeps bold around inline code", () => {
    expect(renderMarkdown("**`mul` is unused.**")).toBe("<p><strong><code>mul</code> is unused.</strong></p>");
  });

  it("renders fenced code without touching its contents", () => {
    expect(renderMarkdown("```\n**not bold** <b>\n```")).toBe("<pre><code>**not bold** &lt;b&gt;</code></pre>");
  });
});
