import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Deps } from "../server/deps.ts";
import type { Scope } from "../server/git.ts";
import type { ReviewedFile } from "../server/review.ts";
import { changedShare } from "../shared.ts";
import { entriesByDir, layoutGraph, type GraphNode, type Placed } from "./graph.ts";
import { api, repoId } from "./api.ts";
import { usePersisted } from "./hooks.ts";
import { plural } from "./util.ts";

interface Props {
  repoName: string;
  scope: Scope;
  files: ReviewedFile[];
  allPaths: string[] | null;
  selected: string | null;
  recent: Map<string, number>;
  threadCounts: Map<string, number>;
  news: Map<string, "new" | "updated">;
  onOpen: (path: string) => void;
  onReview: (files: ReviewedFile[], reviewed: boolean) => void;
  reviewMode: boolean;
  onClearNews: () => void;
}

const FONT = '13px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const BOLD = `600 ${FONT}`;
const SMALL = '12px ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace';
const FRESH_MS = 2 * 60_000;

let ctx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 7.5;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** A pie slice from 12 o'clock, clockwise; tiny changes still get a visible sliver. */
function pie(cx: number, cy: number, r: number, share: number): string | null {
  const f = Math.max(0.08, share);
  if (f >= 0.995) return null;
  const a = f * 2 * Math.PI;
  const x = cx + r * Math.sin(a);
  const y = cy - r * Math.cos(a);
  return `M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)},${y.toFixed(2)} Z`;
}

const newsWidth = (kind: string) => textWidth(kind, `600 11px ${FONT.slice(5)}`) + 14;

const pct = (share: number) => (share >= 0.995 ? "all" : share < 0.01 ? "under 1%" : `about ${Math.round(share * 100)}%`);

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const done = (files: ReviewedFile[]) => files.filter((f) => f.review === "reviewed").length;

function statText(f: ReviewedFile): string {
  if (f.binary) return "bin";
  return [f.added && `+${short(f.added)}`, f.deleted && `−${short(f.deleted)}`].filter(Boolean).join(" ");
}

/** Everything a node shows besides its name, so measuring and drawing agree. */
function dirMeta(files: ReviewedFile[], reviewMode: boolean) {
  if (!files.length) return "";
  if (!reviewMode) return String(files.length);
  const d = done(files);
  return d === files.length ? `✓ ${files.length}` : `${d}/${files.length}`;
}

function measure(node: GraphNode, threads: Map<string, number>, news: Map<string, string>, reviewMode: boolean): number {
  switch (node.kind) {
    case "root":
      return textWidth(node.name, `700 15px ${FONT.slice(5)}`) + 28;
    case "dir":
      return textWidth(node.name, BOLD) + 10 + textWidth(dirMeta(node.files, reviewMode), SMALL) + (node.collapsed ? 16 : 0) + 26 + (node.files.some((f) => news.has(f.path)) ? 12 : 0);
    case "file": {
      const f = node.file;
      let w = 22 + textWidth(node.name, FONT) + 10 + textWidth(statText(f), SMALL);
      if (f.review === "changed") w += 92;
      if (news.get(f.path)) w += newsWidth(news.get(f.path)!) + 8;
      if (threads.get(f.path)) w += 34;
      return w + 14;
    }
    case "unchanged":
    case "ghost":
      return 22 + textWidth(node.name, `italic ${FONT}`);
  }
}

interface Link {
  id: string;
  d: string;
  right: number;
  fromPath: string;
  toPath: string;
  fromLabel: string;
  toLabel: string;
}

/**
 * Import links drawn as arcs off the right end of each label, so they stay clear of
 * the folder branches. A file inside a collapsed folder links from that folder.
 */
function placeLinks(nodes: Placed[], deps: Deps): Link[] {
  const byPath = new Map<string, Placed>();
  const dirs = new Map<string, Placed>();
  for (const n of nodes) {
    if (n.node.kind === "file" || n.node.kind === "ghost") byPath.set(n.node.path, n);
    else if (n.node.kind === "dir") dirs.set(n.node.path, n);
  }
  const visible = (path: string): Placed | null => {
    if (byPath.has(path)) return byPath.get(path)!;
    const parts = path.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const d = dirs.get(parts.slice(0, i).join("/"));
      if (d) return d.node.kind === "dir" && d.node.collapsed ? d : null;
    }
    return null;
  };
  const out = new Map<string, Link>();
  for (const e of deps.edges) {
    const a = visible(e.from);
    const b = visible(e.to);
    if (!a || !b || a === b) continue;
    const id = `${a.node.id}>${b.node.id}`;
    if (out.has(id)) continue;
    const sx = a.x + a.width + 4;
    const tx = b.x + b.width + 6;
    const cx = Math.max(sx, tx) + 26 + Math.abs(b.y - a.y) * 0.3;
    out.set(id, {
      id,
      d: `M${sx},${a.y} C${cx},${a.y} ${cx},${b.y} ${tx},${b.y}`,
      right: cx,
      fromPath: e.from,
      toPath: e.to,
      fromLabel: e.from,
      toLabel: e.to,
    });
  }
  return [...out.values()];
}

/** With many files, open on the folder level: fold folders that hold more than a handful. */
function autoCollapsed(files: ReviewedFile[]): string[] {
  if (files.length <= 24) return [];
  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = f.path.split("/").slice(0, -1).join("/");
    if (dir) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 4).map(([d]) => d);
}

export function MapView(props: Props) {
  const { files, allPaths, selected } = props;
  // null until you fold something yourself; then your choice sticks.
  const [savedCollapsed, setCollapsedList] = usePersisted<string[] | null>("mapCollapsed", null);
  const collapsedList = savedCollapsed ?? autoCollapsed(files);
  const [zoom, setZoom] = usePersisted("mapZoom", 1);
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const entries = useMemo(() => (allPaths ? entriesByDir(allPaths) : null), [allPaths]);
  const [showLinks, setShowLinks] = usePersisted("mapLinks", true);
  const [deps, setDeps] = useState<Deps | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  // Imports move with the files; refetch (debounced) whenever the change does.
  const filesKey = files.map((f) => `${f.path}:${f.mtime}`).join("|");
  useEffect(() => {
    if (!showLinks) return;
    let live = true;
    const t = setTimeout(() => {
      api<Deps>(`/api/repos/${repoId}/deps?scope=${props.scope}`).then((d) => live && setDeps(d), () => {});
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filesKey, showLinks, props.scope]);

  const ghosts = showLinks && deps ? deps.dependents : [];
  const layout = useMemo(
    () => layoutGraph(props.repoName, files, entries, collapsed, (n) => measure(n, props.threadCounts, props.news, props.reviewMode), ghosts),
    [files, entries, collapsed, props.threadCounts, props.repoName, props.news, ghosts, props.reviewMode],
  );
  const links = useMemo(() => (showLinks && deps ? placeLinks(layout.nodes, deps) : []), [layout, deps, showLinks]);
  const width = Math.max(layout.width, ...links.map((l) => l.right + 24));
  const focus = hovered ?? selected;
  const scroller = useRef<HTMLDivElement>(null);

  const maxWeight = Math.max(1, ...layout.nodes.filter((n) => n.node.kind === "file" || n.node.kind === "dir").map((n) => n.weight));
  // Highlight the branch leading to the selected file.
  const onPath = new Set<Placed>();
  for (let p = layout.nodes.find((n) => n.node.kind === "file" && n.node.path === selected) ?? null; p; p = p.parent) onPath.add(p);

  useEffect(() => {
    scroller.current?.querySelector(".gnode.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  // Start where the shape of the change is visible: the root, not the middle of a long list.
  useEffect(() => {
    const el = scroller.current;
    const root = layout.nodes[0];
    if (el && root && !scroller.current?.querySelector(".gnode.selected")) el.scrollTop = Math.max(0, root.y * zoom - el.clientHeight / 2);
  }, []);

  const toggleDir = (path: string) => setCollapsedList(collapsed.has(path) ? collapsedList.filter((p) => p !== path) : [...collapsedList, path]);
  // Folders with no subfolders: collapsing them leaves just the shape of the change.
  const leafDirs = () => {
    const dirs = new Set(files.map((f) => f.path.split("/").slice(0, -1).join("/")).filter(Boolean));
    return [...dirs].filter((d) => ![...dirs].some((o) => o.startsWith(d + "/")));
  };
  const foldersOnly = collapsedList.length > 0;
  const fit = () => {
    const el = scroller.current;
    if (!el) return;
    setZoom(Math.max(0.35, Math.min(1.5, (el.clientWidth - 8) / layout.width, (el.clientHeight - 8) / layout.height)));
  };

  if (!files.length) {
    return (
      <div class="map empty-map">
        <div class="notice">
          <h1>Nothing changed</h1>
          <p>When the agent edits files, they'll appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div class="map">
      <div class="map-tools">
        {props.news.size > 0 && (
          <button class="btn small news-clear" onClick={props.onClearNews} title="Clear the new / updated tags">
            <span class="news-pip-sm" aria-hidden="true" />
            {props.news.size} new · clear
          </button>
        )}
        <button class={`btn small ${showLinks ? "on" : ""}`} onClick={() => setShowLinks(!showLinks)} title="Show which changed files import each other, and unchanged files that use them">
          Imports
        </button>
        <button class={`btn small ${foldersOnly ? "on" : ""}`} onClick={() => setCollapsedList(foldersOnly ? [] : leafDirs())} title="Hide files and show just which folders changed">
          {foldersOnly ? "Show files" : "Folders only"}
        </button>
        <span class="zoom">
          <button class="btn small" onClick={() => setZoom(Math.max(0.35, zoom - 0.15))} aria-label="Zoom out">−</button>
          <button class="btn small" onClick={() => setZoom(1)} title="Actual size">{Math.round(zoom * 100)}%</button>
          <button class="btn small" onClick={() => setZoom(Math.min(2, zoom + 0.15))} aria-label="Zoom in">+</button>
          <button class="btn small" onClick={fit}>Fit</button>
        </span>
      </div>
      <div class="map-scroll" ref={scroller}>
        <svg
          class={`graph ${hovered ? "hovering" : ""}`}
          width={width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${width} ${layout.height}`}
          role="tree"
          aria-label="Changed files as a map"
          onMouseOver={(e) => setHovered((e.target as Element).closest?.("[data-path]")?.getAttribute("data-path") ?? null)}
          onMouseLeave={() => setHovered(null)}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" class="arrow" />
            </marker>
            <marker id="arrow-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" class="arrow hot" />
            </marker>
          </defs>
          <g class="edges">
            {layout.nodes.map((n) => {
              if (!n.parent) return null;
              const p = n.parent;
              const x1 = p.x + p.width;
              const x2 = n.x;
              const mid = (x1 + x2) / 2;
              const unchanged = n.node.kind === "unchanged";
              const files = n.node.kind === "file" ? [n.node.file] : n.node.kind === "dir" ? n.node.files : [];
              const allDone = props.reviewMode && files.length > 0 && done(files) === files.length;
              return (
                <path
                  key={n.node.id}
                  class={`edge ${unchanged ? "faint" : ""} ${allDone ? "done" : ""} ${onPath.has(n) ? "hot" : ""}`}
                  d={`M${x1},${p.y} C${mid},${p.y} ${mid},${n.y} ${x2},${n.y}`}
                  stroke-width={unchanged ? 1 : 1.5 + 5 * Math.sqrt(n.weight / maxWeight)}
                />
              );
            })}
          </g>
          <g class="links">
            {links.map((l) => {
              const hot = !!focus && (l.fromPath === focus || l.toPath === focus);
              return (
                <path key={l.id} class={`link ${hot ? "hot" : ""}`} d={l.d} marker-end={`url(#${hot ? "arrow-hot" : "arrow"})`}>
                  <title>
                    {l.fromLabel} imports {l.toLabel}
                  </title>
                </path>
              );
            })}
          </g>
          {layout.nodes.map((n) => (
            <Node key={n.node.id} placed={n} {...props} onPath={onPath.has(n)} onToggle={toggleDir} />
          ))}
        </svg>
      </div>
      <div class="map-legend" aria-hidden="true">
        <span><i class="ld s-A" />added</span>
        <span><i class="ld s-M" />modified</span>
        <span><i class="ld s-D" />deleted</span>
        <span><i class="ld s-R" />renamed</span>
        {props.reviewMode && <span><i class="ld done" />reviewed</span>}
        {props.reviewMode && <span><i class="ld again" />edited again</span>}
        <span><i class="ld pie" />part of the file changed</span>
        {showLinks && <span><i class="ld link-sample" />imports: hover a file to see what it uses and what uses it</span>}
        {showLinks && <span><i class="ld ghost" />unchanged, but uses a changed file</span>}
        <span class="muted">thicker line = more changed{props.reviewMode ? " · click a dot to mark reviewed" : ""} · click a name to open it</span>
        <span class="muted"><kbd>j</kbd> <kbd>k</kbd> select · <kbd>enter</kbd> open{props.reviewMode ? <> · <kbd>space</kbd> reviewed</> : null} · <kbd>g</kbd> files · <kbd>r</kbd> review mode</span>
      </div>
    </div>
  );
}

function Node(props: Props & { placed: Placed; onPath: boolean; onToggle: (path: string) => void }) {
  const { placed: p } = props;
  const n = p.node;
  const top = p.y - 12;

  if (n.kind === "root" || n.kind === "dir") {
    const d = done(n.files);
    const all = d === n.files.length;
    const meta = n.kind === "dir" ? dirMeta(n.files, props.reviewMode) : "";
    const nameW = textWidth(n.name, n.kind === "root" ? `700 15px ${FONT.slice(5)}` : BOLD);
    return (
      <g
        class={`gnode ${n.kind} ${n.files.length === 0 ? "context" : all && props.reviewMode ? "all-done" : ""} ${props.onPath ? "hot" : ""} ${n.kind === "dir" && n.collapsed ? "collapsed" : ""}`}
        onClick={() => n.kind === "dir" && props.onToggle(n.path)}
        role="treeitem"
        aria-expanded={n.kind === "dir" ? !n.collapsed : true}
      >
        <title>
          {n.kind === "dir" ? `${n.path}\n` : ""}
          {plural(n.files.length, "changed file")}
          {props.reviewMode ? `, ${d} reviewed` : ""}
          {n.kind === "dir" ? `\nClick to ${n.collapsed ? "expand" : "collapse"}` : ""}
        </title>
        <rect x={p.x} y={top} width={p.width} height={24} rx={12} />
        {/* Review progress along the bottom of the pill. */}
        {props.reviewMode && <rect class="pill-progress" x={p.x + 10} y={top + 20} width={n.files.length ? Math.max(0, (p.width - 20) * (d / n.files.length)) : 0} height={2} rx={1} />}
        <text x={p.x + 13} y={p.y + 4.5} class="pill-name">
          {n.name}
        </text>
        {n.kind === "dir" && (
          <text x={p.x + 13 + nameW + 10} y={p.y + 4} class="pill-meta">
            {meta}
            {n.collapsed ? " ▸" : ""}
          </text>
        )}
        {n.kind === "dir" && n.files.some((f) => props.news.has(f.path)) && (
          <circle cx={p.x + p.width - 11} cy={p.y} r={3.5} class="news-pip">
            <title>Something here is new since you last looked</title>
          </circle>
        )}
      </g>
    );
  }

  if (n.kind === "unchanged") {
    return (
      <g class="gnode unchanged">
        <title>Files and folders here that weren't touched</title>
        <circle cx={p.x + 7} cy={p.y} r={4.5} />
        <text x={p.x + 22} y={p.y + 4.5}>
          {n.name}
        </text>
      </g>
    );
  }

  if (n.kind === "ghost") {
    return (
      <g class="gnode ghost" data-path={n.path}>
        <title>{n.path}{"\n"}Not changed, but it imports a file that was. Hover to see which.</title>
        <circle cx={p.x + 7} cy={p.y} r={5} />
        <text x={p.x + 22} y={p.y + 4.5}>
          {n.name}
        </text>
      </g>
    );
  }

  const f = n.file;
  const selected = props.selected === f.path;
  const seen = props.recent.get(f.path) ?? 0;
  const fresh = Date.now() - Math.max(seen, f.mtime ?? 0) < FRESH_MS;
  const threads = props.threadCounts.get(f.path) ?? 0;
  const share = changedShare(f);
  const slice = pie(p.x + 7, p.y, 6.5, share);
  const nameW = textWidth(n.name, FONT);
  const stat = statText(f);
  const statX = p.x + 22 + nameW + 10;
  let extraX = statX + textWidth(stat, SMALL) + 10;
  return (
    <g
      key={seen}
      class={`gnode file s-${f.status} ${f.review ? `r-${f.review}` : ""} ${selected ? "selected" : ""} ${seen && Date.now() - seen < 3000 ? "flash" : ""}`}
      data-path={f.path}
      role="treeitem"
      aria-selected={selected}
      onClick={() => props.onOpen(f.path)}
    >
      <title>
        {f.path}
        {f.oldPath ? `\n(renamed from ${f.oldPath})` : ""}
        {"\nClick to open the diff"}
      </title>
      <rect class="hit" x={p.x - 6} y={top - 1} width={p.width + 12} height={26} rx={6} />
      <g
        class={`dot ${props.reviewMode ? "clickable" : ""}`}
        onClick={(e) => {
          if (!props.reviewMode) return;
          e.stopPropagation();
          props.onReview([f], f.review !== "reviewed");
        }}
      >
        <title>
          {f.status === "A" ? "New file" : f.status === "D" ? "Deleted" : `${pct(share)} of the file changed`}
          {!props.reviewMode ? "" : f.review === "reviewed" ? "\nReviewed. Click to undo" : "\nClick to mark reviewed"}
        </title>
        <circle cx={p.x + 7} cy={p.y} r={10} class="dot-hit" />
        {f.review === "reviewed" ? (
          <>
            <circle cx={p.x + 7} cy={p.y} r={6.5} class="dot-fill" />
            <path d={`M${p.x + 3.8},${p.y + 0.3} l2.2,2.2 l4,-4.6`} class="dot-check" />
          </>
        ) : (
          <>
            {/* Filled share = how much of the file changed. */}
            <circle cx={p.x + 7} cy={p.y} r={6.5} class={slice ? "dot-track" : "dot-fill"} />
            {slice && <path d={slice} class="dot-slice" />}
          </>
        )}
      </g>
      {fresh && <circle cx={p.x + 7} cy={p.y} r={9.5} class="fresh-ring" />}
      <text x={p.x + 22} y={p.y + 4.5} class={`fname ${f.status === "D" ? "deleted" : ""}`}>
        {n.name}
      </text>
      <text x={statX} y={p.y + 4} class="fstat">
        {f.added > 0 && !f.binary && <tspan class="plus">+{short(f.added)}</tspan>}
        {f.added > 0 && f.deleted > 0 && " "}
        {f.deleted > 0 && !f.binary && <tspan class="minus">−{short(f.deleted)}</tspan>}
        {f.binary && <tspan class="bin">bin</tspan>}
      </text>
      {f.review === "changed" &&
        (() => {
          const x = extraX;
          extraX += 92;
          return (
            <g class="again-tag">
              <rect x={x} y={p.y - 9} width={84} height={18} rx={9} />
              <text x={x + 42} y={p.y + 3.5} text-anchor="middle">
                edited again
              </text>
            </g>
          );
        })()}
      {props.news.get(f.path) &&
        (() => {
          const kind = props.news.get(f.path)!;
          const x = extraX;
          const w = newsWidth(kind);
          extraX += w + 8;
          return (
            <g class="news-tag-svg">
              <title>{kind === "new" ? "Appeared since you last looked" : "Changed since you last looked"}</title>
              <rect x={x} y={p.y - 9} width={w} height={18} rx={9} />
              <text x={x + w / 2} y={p.y + 3.5} text-anchor="middle">
                {kind}
              </text>
            </g>
          );
        })()}
      {threads > 0 && (
        <g class="qcount">
          <title>{plural(threads, "question")} asked here</title>
          <path d={`M${extraX + 0.5},${p.y - 5.5} h11 v7 h-6 l-3,2.5 v-2.5 h-2 z`} />
          <text x={extraX + 15} y={p.y + 4}>
            {threads}
          </text>
        </g>
      )}
    </g>
  );
}
