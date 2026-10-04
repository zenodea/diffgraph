// Lays out the changed part of the repo as a left-to-right node-link map:
// repo → folders → changed files. To keep big changes from turning into one very
// tall list, a folder's files sit in a compact grid ("block") that grows sideways
// before it grows down, and each folder notes how much of it went untouched.
import type { ReviewedFile } from "../../server/review/review.ts";

export type GraphNode =
  /** `untouched`: entries directly inside that the change didn't reach. */
  | { kind: "root"; id: string; name: string; files: ReviewedFile[]; untouched: number }
  | { kind: "dir"; id: string; name: string; path: string; files: ReviewedFile[]; collapsed: boolean; untouched: number }
  | { kind: "file"; id: string; name: string; path: string; file: ReviewedFile }
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
  /** For files and ghosts: the block (grid) they sit in. */
  block?: Block;
}

/** A folder's files, laid out as a grid next to it and joined by one comb-shaped connector. */
export interface Block {
  parent: Placed;
  /** Where the connector's spine runs. */
  x: number;
  /** Centre y of each row. */
  rows: number[];
  items: Placed[];
  weight: number;
  /** Right edge of the last column. */
  right: number;
}

export interface Layout {
  nodes: Placed[];
  blocks: Block[];
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

const ROW = 36;
const COL_GAP = 64;
const PAD = 24;
/** Gap between the connector's spine and the first column of files, and between columns. */
const BLOCK_INSET = 22;
const BLOCK_COL_GAP = 48;
/** Extra space after a block, so neighbouring folders' files don't run together. */
const BLOCK_GAP = 28;

/** Columns for a block of n files: tall lists turn into short, wider grids. */
export const blockColumns = (n: number) => (n <= 6 ? 1 : n <= 16 ? 2 : 3);

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
 * Builds and places the graph. `entries` (from the full repo listing) gives the
 * untouched counts and keeps folder chains honest: "src/server" is only folded
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
  const untouched = (d: Dir) => {
    const real = entries?.get(d.path);
    if (!real) return 0;
    const touched = new Set([...d.dirs.keys(), ...d.files.map((f) => f.path.split("/").pop()!), ...d.ghosts.map((g) => g.split("/").pop()!)]);
    return [...real].filter((n) => !touched.has(n)).length;
  };

  const built = new Map<Placed, Placed[]>();

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
      ? { kind: "root", id: "root", name: repoName, files, untouched: untouched(d) }
      : { kind: "dir", id: `d:${d.path}`, name, path: d.path, files, collapsed: collapsed.has(d.path), untouched: untouched(d) };
    const placed: Placed = { node, depth, x: 0, y: 0, width: 0, parent, children: [], weight: weightOf(files) };
    if (node.kind === "dir" && node.collapsed) return placed;

    const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of dirs) placed.children.push(build(sub, depth + 1, placed));
    const items: Placed[] = [];
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
      items.push({ node: { kind: "file", id: `f:${f.path}`, name: f.path.split("/").pop()!, path: f.path, file: f }, depth: depth + 1, x: 0, y: 0, width: 0, parent: placed, children: [], weight: weightOf([f]) });
    }
    for (const g of [...d.ghosts].sort()) {
      items.push({ node: { kind: "ghost", id: `g:${g}`, name: g.split("/").pop()!, path: g }, depth: depth + 1, x: 0, y: 0, width: 0, parent: placed, children: [], weight: 0 });
    }
    built.set(placed, items);
    return placed;
  };

  const root = build(top, 0, null, true);

  // Rows are handed out top to bottom; a parent sits midway between its first and
  // last child. Children start just right of their own parent (not on global
  // columns), so one wide block doesn't push the whole map sideways.
  const nodes: Placed[] = [];
  const blocks: Block[] = [];
  let cursor = PAD;
  let right = 0;
  const rowY = () => {
    const y = cursor + ROW / 2;
    cursor += ROW;
    return y;
  };
  const place = (p: Placed, x: number) => {
    nodes.push(p);
    p.x = x;
    p.width = measure(p.node);
    right = Math.max(right, x + p.width);
    const childX = x + p.width + COL_GAP;
    const items = built.get(p) ?? [];
    if (!p.children.length && !items.length) {
      p.y = rowY();
      return;
    }
    for (const c of p.children) place(c, childX);
    let first = p.children[0]?.y;
    let last = p.children[p.children.length - 1]?.y;
    if (items.length) {
      const cols = blockColumns(items.length);
      const perCol = Math.ceil(items.length / cols);
      const rows = Array.from({ length: perCol }, rowY);
      const colWidths: number[] = [];
      for (const it of items) it.width = measure(it.node);
      // Column-major, so names still read alphabetically down each column.
      items.forEach((it, i) => (colWidths[Math.floor(i / perCol)] = Math.max(colWidths[Math.floor(i / perCol)] ?? 0, it.width)));
      const block: Block = { parent: p, x: childX, rows, items, weight: items.reduce((n, it) => n + it.weight, 0), right: childX };
      let colX = childX + BLOCK_INSET;
      colWidths.forEach((w, c) => {
        items.slice(c * perCol, (c + 1) * perCol).forEach((it, r) => {
          it.x = colX;
          it.y = rows[r];
          it.block = block;
          nodes.push(it);
          right = Math.max(right, colX + it.width);
        });
        colX += w + BLOCK_COL_GAP;
      });
      block.right = colX - BLOCK_COL_GAP;
      blocks.push(block);
      cursor += BLOCK_GAP;
      first ??= rows[0];
      last = rows[rows.length - 1];
    }
    p.y = (first! + last!) / 2;
  };
  place(root, PAD);

  return { nodes, blocks, width: right + PAD, height: Math.max(cursor, PAD + ROW) + PAD };
}
