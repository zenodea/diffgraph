// Draws the map as text: folders branch to the right with box-drawing lines, a
// folder's files sit in a grid next to it (as many columns as the terminal fits),
// and each file's dot fills with how much of it changed.
import type { ReviewedFile } from "../server/review/review.ts";
import { changedShare } from "../shared.ts";
import { bold, c, italic, reset, strike, width } from "./ansi.ts";

export interface Stop {
  kind: "file" | "dir";
  path: string;
  row: number;
  col: number;
  width: number;
}

export interface TextMap {
  rows: string[][];
  stops: Stop[];
}

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: ReviewedFile[];
}

const statusColor: Record<string, string> = { A: c.add, M: c.mod, T: c.mod, D: c.del, R: c.ren, C: c.ren };

/** ○ ◔ ◑ ◕ ●: how much of the file changed. */
function pie(f: ReviewedFile): string {
  if (f.review === "reviewed") return `${c.faint}✓${reset}`;
  const s = changedShare(f);
  const g = s >= 0.85 ? "●" : s >= 0.55 ? "◕" : s >= 0.3 ? "◑" : s > 0 ? "◔" : "○";
  return `${statusColor[f.status] ?? c.mod}${g}${reset}`;
}

function fileLabel(f: ReviewedFile, selected: boolean, news?: string): string {
  const name = f.path.split("/").pop()!;
  const nameStyle = f.status === "D" ? `${c.muted}${strike}` : f.review === "reviewed" ? c.faint : c.text;
  const stats = f.binary
    ? `${c.muted}bin`
    : [f.added ? `${c.add}+${f.added}` : "", f.deleted ? `${c.del}−${f.deleted}` : ""].filter(Boolean).join(" ");
  const sel = selected ? `${c.selBg}${bold}` : "";
  const shownName = selected ? `${sel}${name}` : `${nameStyle}${name}`;
  const again = f.review === "changed" ? ` ${c.warn}edited again${reset}` : "";
  const tag = news ? ` ${c.accent}${news}${reset}` : "";
  return `${pie(f)} ${shownName}${reset} ${stats}${reset}${again}${tag}`;
}

function dirLabel(name: string, count: number, untouched: number, collapsed: boolean, selected: boolean, root = false): string {
  const sel = selected ? `${c.selBg}` : "";
  const label = root ? `${bold}${c.text}${name}` : selected ? `${sel}${bold}${name} ${count}` : `${bold}${c.text}${name}${reset} ${c.muted}${count}`;
  const more = untouched ? ` ${c.faint}${italic}· ${untouched} untouched` : "";
  return `${sel}${label}${collapsed ? ` ${c.muted}▸` : ""}${reset}${more}${reset}`;
}

/** Lays out `files` as a branching text map no wider than `maxWidth` where it can help it. */
export function textMap(
  repoName: string,
  files: ReviewedFile[],
  entries: Map<string, Set<string>> | null,
  collapsed: Set<string>,
  selected: string | null,
  maxWidth: number,
  news: Map<string, string> = new Map(),
): TextMap {
  const top: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let d = top;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!d.dirs.has(parts[i])) d.dirs.set(parts[i], { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      d = d.dirs.get(parts[i])!;
    }
    d.files.push(f);
  }
  const all = (d: Dir): ReviewedFile[] => [...d.files, ...[...d.dirs.values()].flatMap(all)];
  const untouched = (d: Dir) => {
    const real = entries?.get(d.path);
    if (!real) return 0;
    const touched = new Set([...d.dirs.keys(), ...d.files.map((f) => f.path.split("/").pop()!)]);
    return [...real].filter((n) => !touched.has(n)).length;
  };

  const rows: string[][] = [];
  const stops: Stop[] = [];
  const put = (row: number, col: number, text: string) => {
    while (rows.length <= row) rows.push([]);
    rows[row].push(`\x00${col}\x00${text}`);
  };

  // Returns the first free row after this subtree.
  const place = (d0: Dir, row: number, col: number, root = false): number => {
    // Fold "a" → "b" while "a" holds only "b" (in the real repo, when we know it).
    let d = d0;
    let name = d.name;
    while (!root && d.files.length === 0 && d.dirs.size === 1 && (!entries || entries.get(d.path)?.size === 1)) {
      d = [...d.dirs.values()][0];
      name = `${name}/${d.name}`;
    }
    const isCollapsed = !root && collapsed.has(d.path);
    const label = dirLabel(root ? repoName : name, all(d).length, untouched(d), isCollapsed, selected === `d:${d.path}`, root);
    put(row, col, label);
    const w = width(label);
    if (!root) stops.push({ kind: "dir", path: d.path, row, col, width: w });
    if (isCollapsed) return row + 1;

    const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const fileList = [...d.files].sort((a, b) => a.path.localeCompare(b.path));
    const children = dirs.length + (fileList.length ? 1 : 0);
    if (!children) return row + 1;

    const jc = col + w + 2;
    const cc = jc + 3;
    put(row, col + w, `${c.edge} ─`);
    const childRows: number[] = [];
    let r = row;
    for (const sub of dirs) {
      childRows.push(r);
      r = place(sub, r, cc);
    }
    if (fileList.length) {
      childRows.push(r);
      // As many columns as fit, but no more than the count calls for.
      const labels = fileList.map((f) => fileLabel(f, selected === `f:${f.path}`, news.get(f.path)));
      const colW = Math.max(...labels.map(width)) + 4;
      const byCount = fileList.length <= 4 ? 1 : fileList.length <= 10 ? 2 : fileList.length <= 21 ? 3 : 4;
      const fit = Math.max(1, Math.floor((maxWidth - cc) / colW));
      const cols = Math.min(byCount, fit);
      const perCol = Math.ceil(fileList.length / cols);
      fileList.forEach((f, i) => {
        const fr = r + (i % perCol);
        const fc = cc + Math.floor(i / perCol) * colW;
        put(fr, fc, labels[i]);
        stops.push({ kind: "file", path: f.path, row: fr, col: fc, width: width(labels[i]) });
      });
      r += perCol;
      if (perCol > 1) r++; // breathing room after a grid
    }
    // Junctions: ┬/─ on the folder's own row, ├ for middle children, ╰ for the last.
    childRows.forEach((cr, i) => {
      const last = i === childRows.length - 1;
      const j = i === 0 ? (childRows.length > 1 ? "┬" : "─") : last ? "╰" : "├";
      put(cr, jc, `${c.edge}${j}─${reset}`);
      if (!last) for (let k = cr + 1; k < childRows[i + 1]; k++) put(k, jc, `${c.edge}│${reset}`);
    });
    return Math.max(r, row + 1);
  };

  place(top, 0, 1, true);
  // Reading order for j/k: top to bottom, then left to right.
  stops.sort((a, b) => a.row - b.row || a.col - b.col);
  return { rows, stops };
}

/** Turns positioned pieces into one string per row. */
export function renderRows(rows: string[][]): string[] {
  return rows.map((pieces) => {
    let line = "";
    let at = 0;
    const sorted = pieces
      .map((p) => {
        const [, col, text] = p.split("\x00");
        return { col: Number(col), text };
      })
      .sort((a, b) => a.col - b.col);
    for (const { col, text } of sorted) {
      if (col > at) line += " ".repeat(col - at);
      line += text + reset;
      at = Math.max(at, col) + width(text);
    }
    return line;
  });
}

