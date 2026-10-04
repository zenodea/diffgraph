import { describe, expect, it } from "vitest";
import type { ReviewedFile } from "../server/review.ts";
import { entriesByDir, layoutGraph, type Placed } from "./graph.ts";

const file = (path: string, added = 1): ReviewedFile => ({ path, status: "M", added, deleted: 0, binary: false, untracked: false, mtime: null, review: null, reviewedAt: null });
const names = (p: Placed): unknown => (p.children.length ? { [p.node.name]: p.children.map(names) } : p.node.name);
const measure = () => 50;

describe("layoutGraph", () => {
  const files = [file("src/server/a.ts", 10), file("src/web/b.tsx", 30), file("README.md")];
  const all = ["src/server/a.ts", "src/server/old.ts", "src/web/b.tsx", "README.md", "LICENSE", "lib/only/x.ts"];

  it("branches by folder and folds untouched entries into one node", () => {
    const { nodes } = layoutGraph("repo", files, entriesByDir(all), new Set(), measure);
    expect(names(nodes[0])).toEqual({
      repo: [{ src: [{ server: ["a.ts", "1 unchanged"] }, { web: ["b.tsx"] }] }, "README.md", "2 unchanged"],
    });
  });

  it("only merges a folder chain when the outer folder holds nothing else", () => {
    const deep = [file("lib/only/x.ts")];
    expect(names(layoutGraph("r", deep, entriesByDir(["lib/only/x.ts"]), new Set(), measure).nodes[0])).toEqual({ r: [{ "lib/only": ["x.ts"] }] });
    expect(names(layoutGraph("r", deep, entriesByDir(["lib/only/x.ts", "lib/y.ts"]), new Set(), measure).nodes[0])).toEqual({ r: [{ lib: [{ only: ["x.ts"] }, "1 unchanged"] }] });
  });

  it("puts parents midway between their children and weights by lines changed", () => {
    const { nodes } = layoutGraph("repo", files, null, new Set(), measure);
    const src = nodes.find((n) => n.node.name === "src")!;
    expect(src.y).toBe((src.children[0].y + src.children[1].y) / 2);
    expect(src.weight).toBe(40);
  });

  it("collapses folders into a single node", () => {
    const { nodes } = layoutGraph("repo", files, null, new Set(["src/web"]), measure);
    const web = nodes.find((n) => n.node.name === "web")!;
    expect(web.children).toEqual([]);
    expect(web.node.kind === "dir" && web.node.collapsed).toBe(true);
  });
});
