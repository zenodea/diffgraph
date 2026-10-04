// Lays out the changed part of the repo as a left-to-right node-link map:
// repo → folders → changed files, with each folder's untouched entries folded
// into one "n unchanged" node so you can see how much of it the change reached.
import type { ReviewedFile } from "../../server/review/review.ts";

export type GraphNode =
  | { kind: "root"; id: string; name: string; files: ReviewedFile[] }
  | { kind: "dir"; id: string; name: string; path: string; files: ReviewedFile[]; collapsed: boolean }
  | { kind: "file"; id: string; name: string; path: string; file: ReviewedFile }
  | { kind: "unchanged"; id: string; name: string; count: number }
  /** An unchanged file that imports a changed one (shown for context). */
  | { kind: "ghost"; id: string; name: string; path: string };

export interface Placed {
  node: GraphNode;
  depth: number;
  x: number;
  y: number;
  width: number;
  parent: Placed | null;
  children: Placed[];
  /** Lines changed at or below this node (drives edge thickness). */
  weight: number;
}

export interface Layout {
  nodes: Placed[];
  width: number;
  height: number;
}

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: ReviewedFile[];
  ghosts: string[];
}

const ROW = 32;
const COL_GAP = 56;
const PAD = 24;

/** Direct children (file and dir names) of every folder in the repo listing. */
export function entriesByDir(allPaths: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of allPaths) {
    const parts = p.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!out.has(dir)) out.set(dir, new Set());
      out.get(dir)!.add(parts[i]);
    }
  }
  return out;
}

const weightOf = (files: ReviewedFile[]) => files.reduce((n, f) => n + (f.binary ? 1 : f.added + f.deleted), 0);

/**
 * Builds and places the graph. `entries` (from the full repo listing) adds the
 * "n unchanged" nodes and keeps folder chains honest: "src/server" is only folded
 * into one node when "src" holds nothing else. `ghosts` are unchanged files to show
 * for context (importers of changed files). `measure` gives a label's width in px.
 */
export function layoutGraph(
  repoName: string,
  files: ReviewedFile[],
  entries: Map<string, Set<string>> | null,
  collapsed: Set<string>,
  measure: (node: GraphNode) => number,
  ghosts: string[] = [],
): Layout {
  const top: Dir = { name: "", path: "", dirs: new Map(), files: [], ghosts: [] };
  const dirFor = (path: string) => {
    const parts = path.split("/");
    let d = top;
    for (let i = 0; i < parts.length - 1; i++) {
      const sub = parts.slice(0, i + 1).join("/");
      if (!d.dirs.has(parts[i])) d.dirs.set(parts[i], { name: parts[i], path: sub, dirs: new Map(), files: [], ghosts: [] });
      d = d.dirs.get(parts[i])!;
    }
    return d;
  };
  for (const f of files) dirFor(f.path).files.push(f);
  for (const g of ghosts) dirFor(g).ghosts.push(g);

  const all = (d: Dir): ReviewedFile[] => [...d.files, ...[...d.dirs.values()].flatMap(all)];

  const build = (d: Dir, depth: number, parent: Placed | null, root = false): Placed => {
    // Fold "a" → "b" while "a" contains only "b" (in the real repo, when we know it).
    let name = d.name;
    while (!root && d.files.length === 0 && d.ghosts.length === 0 && d.dirs.size === 1) {
      const only = [...d.dirs.values()][0];
      const real = entries?.get(d.path);
      if (real && real.size !== 1) break;
      d = only;
      name = `${name}/${d.name}`;
    }
    const files = all(d);
    const node: GraphNode = root
      ? { kind: "root", id: "root", name: repoName, files }
      : { kind: "dir", id: `d:${d.path}`, name, path: d.path, files, collapsed: collapsed.has(d.path) };
    const placed: Placed = { node, depth, x: 0, y: 0, width: 0, parent, children: [], weight: weightOf(files) };
    if (node.kind === "dir" && node.collapsed) return placed;

    const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of dirs) placed.children.push(build(sub, depth + 1, placed));
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const name = f.path.split("/").pop()!;
      placed.children.push({ node: { kind: "file", id: `f:${f.path}`, name, path: f.path, file: f }, depth: depth + 1, x: 0, y: 0, width: 0, parent: placed, children: [], weight: weightOf([f]) });
    }
    for (const g of [...d.ghosts].sort()) {
      placed.children.push({ node: { kind: "ghost", id: `g:${g}`, name: g.split("/").pop()!, path: g }, depth: depth + 1, x: 0, y: 0, width: 0, parent: placed, children: [], weight: 0 });
    }
    const real = entries?.get(d.path);
    if (real) {
      const touched = new Set([...d.dirs.keys(), ...d.files.map((f) => f.path.split("/").pop()!), ...d.ghosts.map((g) => g.split("/").pop()!)]);
      const count = [...real].filter((n) => !touched.has(n)).length;
      if (count) {
        placed.children.push({ node: { kind: "unchanged", id: `u:${d.path}`, name: `${count} unchanged`, count }, depth: depth + 1, x: 0, y: 0, width: 0, parent: placed, children: [], weight: 0 });
      }
    }
    return placed;
  };

  const root = build(top, 0, null, true);

  // Leaves get consecutive rows; a parent sits midway between its first and last child.
  const nodes: Placed[] = [];
  const colWidth: number[] = [];
  let row = 0;
  const place = (p: Placed) => {
    nodes.push(p);
    p.width = measure(p.node);
    colWidth[p.depth] = Math.max(colWidth[p.depth] ?? 0, p.width);
    if (!p.children.length) p.y = PAD + row++ * ROW + ROW / 2;
    else {
      p.children.forEach(place);
      p.y = (p.children[0].y + p.children[p.children.length - 1].y) / 2;
    }
  };
  place(root);

  const colX: number[] = [];
  colWidth.forEach((w, i) => (colX[i] = i === 0 ? PAD : colX[i - 1] + colWidth[i - 1] + COL_GAP));
  for (const p of nodes) p.x = colX[p.depth];
  const last = colWidth.length - 1;
  return { nodes, width: colX[last] + colWidth[last] + PAD, height: PAD * 2 + Math.max(row, 1) * ROW };
}
