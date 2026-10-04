import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.ts";

const text = `diff --git a/x.ts b/x.ts
index 1..2 100644
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,4 @@ function top() {
 keep
-old
+new
+added
 tail
@@ -10 +11,0 @@
-gone
\\ No newline at end of file
`;

describe("parseDiff", () => {
  it("numbers old and new lines per hunk", () => {
    const [a, b] = parseDiff(text);
    expect(a).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, context: "function top() {" });
    expect(a.lines.map((l) => [l.t, l.o, l.n, l.s])).toEqual([
      [" ", 1, 1, "keep"],
      ["-", 2, null, "old"],
      ["+", null, 2, "new"],
      ["+", null, 3, "added"],
      [" ", 3, 4, "tail"],
    ]);
    expect(b).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 11, newLines: 0 });
    expect(b.lines).toEqual([{ t: "-", o: 10, n: null, s: "gone" }]);
  });
});
