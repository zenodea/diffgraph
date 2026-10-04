import { describe, expect, it } from "vitest";
import type { ReviewedFile } from "../../server/review/review.ts";
import { blockColumns, entriesByDir, layoutGraph, type Placed } from "./graph.ts";

const file = (path: string, added = 1): ReviewedFile => ({ path, status: "M", added, deleted: 0, binary: false, untracked: false, mtime: null, lines: 10, review: null, reviewedAt: null });
const measure = () => 50;

describe("changedShare", () => {
  it("is the touched share of old and new lines", async () => {
    const { changedShare } = await import("../../shared.ts");
    expect(changedShare({ status: "M", added: 5, deleted: 5, lines: 100, binary: false })).toBeCloseTo(10 / 105);
    expect(changedShare({ status: "A", added: 5, deleted: 0, lines: 5, binary: false })).toBe(1);
    expect(changedShare({ status: "M", added: 0, deleted: 0, lines: 0, binary: false })).toBe(0);
  });
});

/** The tree as nested names: folders map to their subfolders, then their files. */
function shape(layout: ReturnType<typeof layoutGraph>, p: Placed = layout.nodes[0]): unknown {
  const block = layout.blocks.find((b) => b.parent === p);
  const kids = [...p.children.map((c) => shape(layout, c)), ...(block?.items.map((it) => it.node.name) ?? [])];
  const label = p.node.kind === "dir" || p.node.kind === "root" ? `${p.node.name}${p.node.untouched ? ` (+${p.node.untouched})` : ""}` : p.node.name;
  return kids.length ? { [label]: kids } : label;
}

describe("layoutGraph", () => {
  const files = [file("src/server/a.ts", 10), file("src/web/b.tsx", 30), file("README.md")];
  const all = ["src/server/a.ts", "src/server/old.ts", "src/web/b.tsx", "README.md", "LICENSE", "lib/only/x.ts"];

  it("branches by folder and counts untouched entries on the folder", () => {
    const layout = layoutGraph("repo", files, entriesByDir(all), new Set(), measure);
    expect(shape(layout)).toEqual({ "repo (+2)": [{ src: [{ "server (+1)": ["a.ts"] }, { web: ["b.tsx"] }] }, "README.md"] });
  });

  it("only merges a folder chain when the outer folder holds nothing else", () => {
    const deep = [file("lib/only/x.ts")];
    expect(shape(layoutGraph("r", deep, entriesByDir(["lib/only/x.ts"]), new Set(), measure))).toEqual({ r: [{ "lib/only": ["x.ts"] }] });
    expect(shape(layoutGraph("r", deep, entriesByDir(["lib/only/x.ts", "lib/y.ts"]), new Set(), measure))).toEqual({ r: [{ "lib (+1)": [{ only: ["x.ts"] }] }] });
  });

  it("wraps a big folder's files into columns, filled top to bottom", () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`big/f${String(i).padStart(2, "0")}.ts`));
    const layout = layoutGraph("repo", many, null, new Set(), measure);
    const block = layout.blocks[0];
    expect(blockColumns(12)).toBe(3);
    expect(block.rows).toHaveLength(4);
    const xs = [...new Set(block.items.map((it) => it.x))];
    expect(xs).toHaveLength(3);
    expect(block.items.filter((it) => it.x === xs[0]).map((it) => it.node.name)).toEqual(["f00.ts", "f01.ts", "f02.ts", "f03.ts"]);
  });

  it("puts parents midway between their children and weights by lines changed", () => {
    const { nodes } = layoutGraph("repo", files, null, new Set(), measure);
    const src = nodes.find((n) => n.node.name === "src")!;
    expect(src.y).toBe((src.children[0].y + src.children[1].y) / 2);
    expect(src.weight).toBe(40);
  });

  it("collapses folders into a single node", () => {
    const layout = layoutGraph("repo", files, null, new Set(["src/web"]), measure);
    const web = layout.nodes.find((n) => n.node.name === "web")!;
    expect(web.node.kind === "dir" && web.node.collapsed).toBe(true);
    expect(layout.nodes.some((n) => n.node.name === "b.tsx")).toBe(false);
  });
});
