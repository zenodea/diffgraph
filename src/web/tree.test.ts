import { describe, expect, it } from "vitest";
import type { ReviewedFile as ChangedFile } from "../server/review.ts";
import { buildTree, visibleOrder } from "./tree.ts";

const file = (path: string): ChangedFile => ({ path, status: "M", added: 1, deleted: 0, binary: false, untracked: false, mtime: null, lines: 10, review: null, reviewedAt: null });

describe("buildTree", () => {
  it("compacts single-child folder chains and sorts folders first", () => {
    const paths = ["src/a/b/c.ts", "src/a/b/d.ts", "README.md", "src/z.ts"];
    const tree = buildTree(paths, new Map(paths.map((p) => [p, file(p)])));
    expect(tree.children.map((c) => c.name)).toEqual(["src", "README.md"]);
    const src = tree.children[0];
    expect(src.children.map((c) => c.name)).toEqual(["a/b", "z.ts"]);
    expect(src.children[0].path).toBe("src/a/b");
    expect(src.changed).toHaveLength(3);
  });

  it("orders visible files and skips collapsed folders", () => {
    const paths = ["b/x.ts", "a/y.ts", "top.ts"];
    const tree = buildTree(paths, new Map(paths.map((p) => [p, file(p)])));
    expect(visibleOrder(tree, new Set()).map((f) => f.path)).toEqual(["a/y.ts", "b/x.ts", "top.ts"]);
    expect(visibleOrder(tree, new Set(["a"])).map((f) => f.path)).toEqual(["b/x.ts", "top.ts"]);
  });

  it("leaves unchanged files without change info", () => {
    const tree = buildTree(["a.ts", "b.ts"], new Map([["a.ts", file("a.ts")]]));
    expect(tree.children.map((c) => !!c.file)).toEqual([true, false]);
  });
});
