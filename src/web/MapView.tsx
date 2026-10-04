import { useEffect, useMemo, useRef } from "preact/hooks";
import type { ReviewedFile } from "../server/review.ts";
import { entriesByDir, layoutGraph, type GraphNode, type Placed } from "./graph.ts";
import { usePersisted } from "./hooks.ts";
import { plural } from "./util.ts";

interface Props {
  repoName: string;
  files: ReviewedFile[];
  allPaths: string[] | null;
  selected: string | null;
  recent: Map<string, number>;
  threadCounts: Map<string, number>;
  onOpen: (path: string) => void;
  onReview: (files: ReviewedFile[], reviewed: boolean) => void;
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

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const done = (files: ReviewedFile[]) => files.filter((f) => f.review === "reviewed").length;

function statText(f: ReviewedFile): string {
  if (f.binary) return "bin";
  return [f.added && `+${short(f.added)}`, f.deleted && `−${short(f.deleted)}`].filter(Boolean).join(" ");
}

/** Everything a node shows besides its name, so measuring and drawing agree. */
function dirMeta(files: ReviewedFile[]) {
  const d = done(files);
  return d === files.length ? `✓ ${files.length}` : `${d}/${files.length}`;
}

function measure(node: GraphNode, threads: Map<string, number>): number {
  switch (node.kind) {
    case "root":
      return textWidth(node.name, `700 15px ${FONT.slice(5)}`) + 28;
    case "dir":
      return textWidth(node.name, BOLD) + 10 + textWidth(dirMeta(node.files), SMALL) + (node.collapsed ? 16 : 0) + 26;
    case "file": {
      const f = node.file;
      let w = 22 + textWidth(node.name, FONT) + 10 + textWidth(statText(f), SMALL);
      if (f.review === "changed") w += 92;
      if (threads.get(f.path)) w += 34;
      return w + 14;
    }
    case "unchanged":
      return 22 + textWidth(node.name, `italic ${FONT}`);
  }
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
  const layout = useMemo(
    () => layoutGraph(props.repoName, files, entries, collapsed, (n) => measure(n, props.threadCounts)),
    [files, entries, collapsed, props.threadCounts, props.repoName],
  );
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
        <svg class="graph" width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`} role="tree" aria-label="Changed files as a map">
          <g class="edges">
            {layout.nodes.map((n) => {
              if (!n.parent) return null;
              const p = n.parent;
              const x1 = p.x + p.width;
              const x2 = n.x;
              const mid = (x1 + x2) / 2;
              const unchanged = n.node.kind === "unchanged";
              const files = n.node.kind === "file" ? [n.node.file] : n.node.kind === "dir" ? n.node.files : [];
              const allDone = files.length > 0 && done(files) === files.length;
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
        <span><i class="ld done" />reviewed</span>
        <span><i class="ld again" />edited again</span>
        <span class="muted">thicker line = more changed · click a dot to mark reviewed · click a name to open it</span>
        <span class="muted"><kbd>j</kbd> <kbd>k</kbd> select · <kbd>enter</kbd> open · <kbd>space</kbd> reviewed · <kbd>g</kbd> files</span>
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
    const meta = n.kind === "dir" ? dirMeta(n.files) : `${d}/${n.files.length}`;
    const nameW = textWidth(n.name, n.kind === "root" ? `700 15px ${FONT.slice(5)}` : BOLD);
    return (
      <g
        class={`gnode ${n.kind} ${all ? "all-done" : ""} ${props.onPath ? "hot" : ""} ${n.kind === "dir" && n.collapsed ? "collapsed" : ""}`}
        onClick={() => n.kind === "dir" && props.onToggle(n.path)}
        role="treeitem"
        aria-expanded={n.kind === "dir" ? !n.collapsed : true}
      >
        <title>
          {n.kind === "dir" ? `${n.path}\n` : ""}
          {plural(n.files.length, "changed file")}, {d} reviewed{n.kind === "dir" ? `\nClick to ${n.collapsed ? "expand" : "collapse"}` : ""}
        </title>
        <rect x={p.x} y={top} width={p.width} height={24} rx={12} />
        {/* Review progress along the bottom of the pill. */}
        <rect class="pill-progress" x={p.x + 10} y={top + 20} width={Math.max(0, (p.width - 20) * (d / n.files.length))} height={2} rx={1} />
        <text x={p.x + 13} y={p.y + 4.5} class="pill-name">
          {n.name}
        </text>
        {n.kind === "dir" && (
          <text x={p.x + 13 + nameW + 10} y={p.y + 4} class="pill-meta">
            {meta}
            {n.collapsed ? " ▸" : ""}
          </text>
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

  const f = n.file;
  const selected = props.selected === f.path;
  const seen = props.recent.get(f.path) ?? 0;
  const fresh = Date.now() - Math.max(seen, f.mtime ?? 0) < FRESH_MS;
  const threads = props.threadCounts.get(f.path) ?? 0;
  const nameW = textWidth(n.name, FONT);
  const stat = statText(f);
  const statX = p.x + 22 + nameW + 10;
  let extraX = statX + textWidth(stat, SMALL) + 10;
  return (
    <g
      key={seen}
      class={`gnode file s-${f.status} ${f.review ? `r-${f.review}` : ""} ${selected ? "selected" : ""} ${seen && Date.now() - seen < 3000 ? "flash" : ""}`}
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
        class="dot"
        onClick={(e) => {
          e.stopPropagation();
          props.onReview([f], f.review !== "reviewed");
        }}
      >
        <title>{f.review === "reviewed" ? "Reviewed. Click to undo" : "Click to mark reviewed"}</title>
        <circle cx={p.x + 7} cy={p.y} r={10} class="dot-hit" />
        <circle cx={p.x + 7} cy={p.y} r={6.5} class="dot-fill" />
        {f.review === "reviewed" && <path d={`M${p.x + 3.8},${p.y + 0.3} l2.2,2.2 l4,-4.6`} class="dot-check" />}
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
