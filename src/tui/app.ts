// The map in the terminal. Talks to the same local server as the browser page, so
// scopes, diffs and live updates behave the same; it just draws with text.
import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import type { Changes } from "../server/git/changes.ts";
import type { DiffLine, Hunk } from "../server/git/diff.ts";
import type { Scope } from "../server/git/git.ts";
import type { ReviewedFile } from "../server/review/review.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type Connection } from "../connect.ts";
import { stateDir } from "../server/core/env.ts";
import { bold, c, dim, inverse, pad, reset, screen, truncate, width } from "./ansi.ts";
import { renderRows, textMap, type Stop } from "./layout.ts";

type Reviewed = Omit<Changes, "files"> & { files: ReviewedFile[] };

const SCOPES: { id: Scope; label: string }[] = [
  { id: "branch", label: "Branch" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "session", label: "Session" },
  { id: "prompt", label: "Last prompt" },
];

interface State {
  conn: Connection;
  scope: Scope;
  changes: Reviewed | null;
  entries: Map<string, Set<string>> | null;
  collapsed: Set<string>;
  sel: string | null;
  view: "map" | "diff";
  diff: { path: string; lines: string[]; error?: string } | null;
  scrollY: number;
  scrollX: number;
  diffScroll: number;
  agent: string | null;
  message: string | null;
  help: boolean;
  /** What each folder is for (the Guide): always loaded, shown in the bottom bar. */
  guide: Record<string, string> | null;
  guidePending: string[];
  /** Also show a short version next to each folder (i). */
  guideInline: boolean;
}

export async function runTui(): Promise<void> {
  const cwd = process.cwd();
  const conn = await connect(cwd, process.env.GRAPHDIFF_PANE ?? null, process.env.GRAPHDIFF_AGENT ?? null);
  if (!conn) {
    process.stdout.write(`${cwd} isn't inside a git repo. Press any key.\n`);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    await new Promise((r) => process.stdin.once("data", r));
    process.exit(0);
  }

  const s: State = {
    conn,
    scope: "branch",
    changes: null,
    entries: null,
    collapsed: new Set(),
    sel: null,
    view: "map",
    diff: null,
    scrollY: 0,
    scrollX: 0,
    diffScroll: 0,
    agent: null,
    message: null,
    help: false,
    guide: {},
    guidePending: [],
    guideInline: false,
  };

  const api = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${conn.base}${path}`, { headers: { "x-graphdiff-token": conn.token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data as T;
  };
  const repoApi = (p: string) => `/api/repos/${conn.repo.id}/${p}`;

  // ---- drawing --------------------------------------------------------------
  let prev: string[] = [];
  let lastStops: Stop[] = [];
  const out = process.stdout;

  const draw = () => {
    const W = out.columns || 100;
    const H = out.rows || 30;
    const body = H - 2;
    const lines: string[] = [topBar(s, W)];
    if (s.help) lines.push(...helpLines(body));
    else if (s.view === "diff") lines.push(...diffBody(s, W, body));
    else lines.push(...mapBody(s, W, body, (stops) => (lastStops = stops)));
    while (lines.length < H - 1) lines.push("");
    lines.length = H - 1;
    lines.push(bottomBar(s, W));
    let buf = "";
    lines.forEach((line, i) => {
      const l = truncate(line, W);
      if (l !== prev[i]) buf += `\x1b[${i + 1};1H${l}${reset}${screen.clearLine}`;
    });
    prev = lines.map((l) => truncate(l, W));
    if (buf) out.write(buf);
  };

  // ---- data -----------------------------------------------------------------
  const load = async () => {
    try {
      const [changes, files] = await Promise.all([api<Reviewed>(repoApi(`changes?scope=${s.scope}`)), s.entries ? null : api<{ paths: string[] }>(repoApi("files"))]);
      // No review mode here (yet), so don't show review state, same as the browser outside it.
      s.changes = { ...changes, files: changes.files.map((f) => ({ ...f, review: null, reviewedAt: null })) };
      if (files) s.entries = entriesByDir(files.paths);
      s.message = null;
      if (s.view === "diff" && s.diff) await openDiff(s.diff.path, true);
    } catch (e) {
      s.message = (e as Error).message;
      if (s.scope === "session" || s.scope === "prompt") s.scope = "branch";
    }
    draw();
    void fillGuide();
  };

  const openDiff = async (path: string, keepScroll = false) => {
    try {
      const d = await api<{ hunks: Hunk[]; binary: boolean; tooLarge: boolean; file: ReviewedFile }>(repoApi(`diff?scope=${s.scope}&path=${encodeURIComponent(path)}`));
      s.diff = { path, lines: diffLines(d) };
    } catch (e) {
      s.diff = { path, lines: [], error: (e as Error).message };
    }
    if (!keepScroll) s.diffScroll = 0;
    s.view = "diff";
    draw();
  };

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${conn.base}${path}`, { method: "POST", headers: { "x-graphdiff-token": conn.token, "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as T;
  };
  // Describe whichever folders on screen don't have a Guide line yet (one call for all).
  const fillGuide = async () => {
    if (!s.guide) return;
    const missing = lastStops.filter((st) => st.kind === "dir" && !(st.path in s.guide!) && !s.guidePending.includes(st.path)).map((st) => st.path);
    if (!missing.length) return;
    const g = await post<{ folders: Record<string, string>; pending: string[] }>(repoApi("guide"), { folders: missing }).catch(() => null);
    if (g) {
      s.guide = g.folders;
      s.guidePending = g.pending;
      draw();
    }
  };
  const loadGuide = async () => {
    const g = await api<{ folders: Record<string, string>; pending: string[] }>(repoApi("guide")).catch(() => null);
    if (g) {
      s.guide = g.folders;
      s.guidePending = g.pending;
    }
  };

  // Live: the same event stream the page uses.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLoad = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 120);
  };
  const listen = async () => {
    for (;;) {
      try {
        const res = await fetch(`${conn.base}${repoApi("events")}?t=${conn.token}`);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (event === "changes" || event === "hello") scheduleLoad();
            if (event === "guide" && data && s.guide) {
              const g = JSON.parse(data);
              s.guide = g.folders;
              s.guidePending = g.pending;

              draw();
            }
            if ((event === "agent" || event === "hello") && data) {
              s.agent = JSON.parse(data).agent;
              draw();
            }
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  // ---- input ----------------------------------------------------------------
  // Like the browser map: j/k visit files and folded folders, not open ones.
  const navStops = () => lastStops.filter((st) => st.kind === "file" || s.collapsed.has(st.path));
  const move = (delta: number) => {
    const stops = navStops();
    if (!stops.length) return;
    const i = stops.findIndex((st) => key(st) === s.sel);
    const next = stops[Math.max(0, Math.min(stops.length - 1, i === -1 ? 0 : i + delta))];
    s.sel = key(next);
  };
  const selectedStop = () => lastStops.find((st) => key(st) === s.sel);

  const quit = () => {
    out.write(screen.leave);
    process.exit(0);
  };

  const onKey = (str: string | undefined, k: { name?: string; ctrl?: boolean; shift?: boolean }) => {
    if (k.ctrl && k.name === "c") return quit();
    s.message = null;
    if (s.help) {
      s.help = false;
      return draw();
    }
    if (str === "?") s.help = true;
    else if (s.view === "diff") {
      const page = Math.max(1, (out.rows || 30) - 4);
      if (k.name === "q" || k.name === "escape" || k.name === "h" || k.name === "left") s.view = "map";
      else if (k.name === "j" || k.name === "down") s.diffScroll++;
      else if (k.name === "k" || k.name === "up") s.diffScroll = Math.max(0, s.diffScroll - 1);
      else if (k.name === "d" || k.name === "space" || k.name === "pagedown") s.diffScroll += page / 2;
      else if (k.name === "u" || k.name === "pageup") s.diffScroll = Math.max(0, s.diffScroll - page / 2);
      else if (str === "J" || str === "K") {
        // Next / previous file without going back to the map.
        const files = lastStops.filter((st) => st.kind === "file");
        const i = files.findIndex((st) => st.path === s.diff?.path);
        const next = files[i + (str === "J" ? 1 : -1)];
        if (next) {
          s.sel = key(next);
          return void openDiff(next.path);
        }
      } else if (str === "o") openInBrowser(s, s.diff?.path);
    } else {
      if (k.name === "q" || k.name === "escape") return quit();
      if (k.name === "j" || k.name === "down") move(1);
      else if (k.name === "k" || k.name === "up") move(-1);
      else if (str === "g") s.sel = navStops()[0] ? key(navStops()[0]) : null;
      else if (str === "G") s.sel = navStops().at(-1) ? key(navStops().at(-1)!) : null;
      else if (k.name === "l" || k.name === "right" || k.name === "return") {
        const st = selectedStop();
        if (st?.kind === "dir" && s.collapsed.has(st.path)) s.collapsed.delete(st.path);
        else if (st?.kind === "file" && (k.name === "return" || k.name === "l")) return void openDiff(st.path);
      } else if (k.name === "h" || k.name === "left") {
        // Fold the folder you're in (or the one above a folder).
        const st = selectedStop();
        if (st) {
          const parent = st.kind === "dir" && !s.collapsed.has(st.path) ? st.path : st.path.split("/").slice(0, -1).join("/");
          const dir = lastStops.filter((d) => d.kind === "dir" && (parent === d.path || parent.startsWith(d.path + "/"))).sort((a, b) => b.path.length - a.path.length)[0];
          if (dir) {
            s.collapsed.add(dir.path);
            s.sel = key(dir);
          }
        }
      } else if (str === "s" || k.name === "tab") {
        const i = SCOPES.findIndex((x) => x.id === s.scope);
        s.scope = SCOPES[(i + 1) % SCOPES.length].id;
        s.changes = null;
        return void load();
      } else if (str === "r") return void load();
      else if (str === "i") s.guideInline = !s.guideInline;
      else if (str === "o") openInBrowser(s, selectedStop()?.kind === "file" ? selectedStop()!.path : undefined);
      else return;
    }
    draw();
  };

  // ---- start ----------------------------------------------------------------
  out.write(screen.enter + screen.home + screen.clearBelow);
  const restore = () => out.write(screen.leave);
  process.on("exit", restore);
  process.on("SIGTERM", quit);
  process.on("uncaughtException", (e) => void showCrash(e));
  process.on("unhandledRejection", (e) => void showCrash(e));
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", onKey);
  out.on("resize", () => {
    prev = [];
    out.write(screen.home + screen.clearBelow);
    draw();
  });
  draw();
  await loadGuide();
  await load();
  void listen();
}

/**
 * Something broke: log it, and keep the pane open with the error on screen (a
 * herdr overlay closes when its process exits, which would hide what happened).
 */
export async function showCrash(e: unknown): Promise<never> {
  const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
  try {
    appendFileSync(join(stateDir, "tui.log"), `${new Date().toISOString()} ${process.cwd()}\n${text}\n\n`);
  } catch {}
  process.stdout.write(`${screen.leave}\n${c.del}graphdiff hit an error:${reset}\n${text}\n\n${c.muted}(also in ${join(stateDir, "tui.log")}) · any key to close${reset}\n`);
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch {}
  process.stdin.resume();
  await new Promise((r) => process.stdin.once("data", r));
  process.exit(1);
}

const key = (st: Stop) => `${st.kind === "file" ? "f" : "d"}:${st.path}`;

function entriesByDir(paths: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!out.has(dir)) out.set(dir, new Set());
      out.get(dir)!.add(parts[i]);
    }
  }
  return out;
}

function topBar(s: State, W: number): string {
  const ch = s.changes;
  const scopes = SCOPES.map((x) => (x.id === s.scope ? `${inverse} ${x.label} ${reset}${c.barBg}` : `${c.muted} ${x.label} ${reset}${c.barBg}`)).join("");
  const branch = ch?.branch ? `${c.muted}${ch.branch}${s.scope === "branch" && ch.base ? ` → ${ch.base}` : ""}` : "";
  const totals = ch
    ? `${c.muted}${ch.files.length} files ${c.add}+${ch.files.reduce((n, f) => n + f.added, 0)} ${c.del}−${ch.files.reduce((n, f) => n + f.deleted, 0)}`
    : `${c.muted}loading…`;
  const [name, status] = s.agent?.split(":") ?? [];
  const agent = name ? `${status === "working" ? c.accent : status === "blocked" ? c.warn : c.done}● ${name} ${status === "idle" || status === "done" ? "idle" : status}` : "";
  const left = ` ${bold}${c.text}${s.conn.repo.name}${reset}${c.barBg}  ${branch}${reset}${c.barBg}  ${scopes}`;
  const right = `${totals}${reset}${c.barBg}  ${agent}${reset}${c.barBg} `;
  const gap = Math.max(1, W - width(left) - width(right));
  return `${c.barBg}${left}${" ".repeat(gap)}${right}${reset}`;
}

function bottomBar(s: State, W: number): string {
  if (s.message) return truncate(`${c.warn} ${s.message}`, W);
  if (s.guide && s.view === "map" && s.sel) {
    // The selected folder's full Guide line (or the folder of the selected file).
    const path = s.sel.slice(2);
    const folder = s.sel.startsWith("d:") ? path : path.split("/").slice(0, -1).join("/");
    const line = s.guide[folder];
    if (line) return truncate(` ${c.accent}${folder}/${reset} ${c.text}${line}${reset}`, W);
  }
  const hints =
    s.view === "diff"
      ? "j k scroll · d u page · J K next/prev file · o browser · q back"
      : "j k move · l/enter open · h fold · s scope · i notes · o browser · ? help · q quit";
  return `${c.faint} ${hints}${reset}`;
}

function helpLines(H: number): string[] {
  const rows = [
    "",
    `  ${bold}On the map${reset}`,
    `  ${c.add}●${reset} added   ${c.mod}◑${reset} modified   ${c.del}●${reset} deleted   ${c.ren}◑${reset} renamed`,
    `  ○ ◔ ◑ ◕ ●  how much of the file changed`,
    `  ${c.faint}· n untouched${reset}  files in that folder the change didn't reach`,
    "",
    `  ${bold}Keys${reset}`,
    `  j k / ↓ ↑     move between files and folded folders`,
    `  l, enter      unfold a folder · open a file's diff`,
    `  h             fold the folder you're in`,
    `  g G           first · last`,
    `  s, tab        next scope (branch, uncommitted, session, last prompt)`,
    `  i             guide notes next to every folder (the bottom bar always has it)`,
    `  o             open this in the browser`,
    `  r             refresh`,
    `  q, esc        back · quit`,
    "",
    `  ${c.faint}any key to close${reset}`,
  ];
  return rows.slice(0, H);
}

function mapBody(s: State, W: number, H: number, setStops: (stops: Stop[]) => void): string[] {
  if (!s.changes) return [`  ${c.muted}Loading…`];
  if (!s.changes.files.length) {
    setStops([]);
    return ["", `  ${bold}Nothing changed${reset}`, `  ${c.muted}When the agent edits files, they'll appear here.`];
  }
  let final = textMap(s.conn.repo.name, s.changes.files, s.entries, s.collapsed, s.sel, W - 2, undefined, s.guideInline ? s.guide : null);
  if (!s.sel || !final.stops.some((st) => key(st) === s.sel)) {
    // Nothing (valid) selected yet: pick the first file and lay out again to highlight it.
    const first = final.stops.find((st) => st.kind === "file") ?? final.stops[0];
    s.sel = first ? key(first) : null;
    final = textMap(s.conn.repo.name, s.changes.files, s.entries, s.collapsed, s.sel, W - 2, undefined, s.guideInline ? s.guide : null);
  }
  setStops(final.stops);
  const lines = renderRows(final.rows);
  // Keep the selection on screen, vertically and sideways.
  const st = final.stops.find((x) => key(x) === s.sel);
  if (st) {
    if (st.row < s.scrollY + 1) s.scrollY = Math.max(0, st.row - 1);
    if (st.row > s.scrollY + H - 3) s.scrollY = st.row - H + 3;
    if (st.col + st.width > s.scrollX + W - 2) s.scrollX = st.col + st.width - W + 4;
    if (st.col < s.scrollX + 2) s.scrollX = Math.max(0, st.col - 4);
  }
  return ["", ...lines.slice(s.scrollY, s.scrollY + H - 1).map((l) => sliceCols(l, s.scrollX, W))];
}

function diffBody(s: State, W: number, H: number): string[] {
  const d = s.diff;
  if (!d) return [];
  const f = s.changes?.files.find((x) => x.path === d.path);
  const head = ` ${bold}${c.text}${d.path}${reset}  ${f ? `${c.add}+${f.added} ${c.del}−${f.deleted}` : ""}${reset}`;
  if (d.error) return [head, "", `  ${c.warn}${d.error}`];
  const max = Math.max(0, d.lines.length - (H - 2));
  s.diffScroll = Math.min(Math.round(s.diffScroll), max);
  return [head, "", ...d.lines.slice(s.diffScroll, s.diffScroll + H - 2).map((l) => truncate(l, W))];
}

function diffLines(d: { hunks: Hunk[]; binary: boolean; tooLarge: boolean }): string[] {
  if (d.binary) return [`  ${c.muted}Binary file.`];
  if (d.tooLarge) return [`  ${c.muted}This diff is too large to show here.`];
  if (!d.hunks.length) return [`  ${c.muted}No line changes.`];
  const W = process.stdout.columns || 100;
  const out: string[] = [];
  for (const h of d.hunks) {
    const end = h.newStart + Math.max(h.newLines - 1, 0);
    out.push(`${c.faint}${dim}  ── lines ${h.newStart}–${end}${h.context ? `  ${h.context.trim()}` : ""} ${"─".repeat(20)}${reset}`);
    for (const l of h.lines) out.push(diffLine(l, W));
  }
  return out;
}

function diffLine(l: DiffLine, W: number): string {
  const o = String(l.o ?? "").padStart(5);
  const n = String(l.n ?? "").padStart(5);
  const text = l.s.replace(/\t/g, "  ");
  if (l.t === "+") return `${c.addBg}${c.add}${o} ${n} + ${c.text}${pad(text, W - 14)}${reset}`;
  if (l.t === "-") return `${c.delBg}${c.del}${o} ${n} − ${c.text}${pad(text, W - 14)}${reset}`;
  return `${c.faint}${o} ${n}   ${reset}${c.muted}${text}${reset}`;
}

/** The visible columns [from, from + len) of a styled line. */
function sliceCols(line: string, from: number, len: number): string {
  if (!from) return line;
  let out = "";
  let col = 0;
  for (const part of line.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (col >= from && col < from + len) out += ch;
      col++;
    }
  }
  return out;
}

function openInBrowser(s: State, path?: string) {
  const url = `${s.conn.base}/r/${s.conn.repo.id}?t=${s.conn.token}${path ? `#${encodeURIComponent(path).replace(/%2F/g, "/")}` : ""}`;
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  s.message = "Opened in the browser";
}

