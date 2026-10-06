import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Deps } from "../../server/deps/deps.ts";
import type { Scope } from "../../server/git/git.ts";
import type { ReviewedFile } from "../../server/review/review.ts";
import type { Summary } from "../../server/agents/summaries.ts";
import type { Source } from "../../server/agents/sources.ts";
import type { Risks } from "../../server/deps/risks.ts";
import { changedShare } from "../../shared.ts";
import { entriesByDir, layoutGraph, type GraphNode, type Placed } from "./graph.ts";
import { api, repoId } from "../lib/api.ts";
import { useKeys, usePersisted } from "../lib/hooks.ts";
import { usePanZoom } from "./panzoom.ts";
import { plural } from "../lib/util.ts";

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
  onSelect: (path: string) => void;
  onReview: (files: ReviewedFile[], reviewed: boolean) => void;
  reviewMode: boolean;
  onClearNews: () => void;
}

const FONT = '13px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const BOLD = `600 ${FONT}`;
const SMALL = '12px ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace';
const UNTOUCHED = `italic 12px ${FONT.slice(5)}`;
/** Entries in a folder the change didn't reach, shown in its pill. */
const untouchedText = (n: number) => `· ${n} untouched`;
const FRESH_MS = 2 * 60_000;

let ctx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();
/** Label width in px, measured once per font and text (the map asks for thousands per render). */
function textWidth(text: string, font: string): number {
  const key = `${font}\u0000${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    ctx ??= document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = font;
      w = ctx.measureText(text).width;
    } else w = text.length * 7.5;
    widths.set(key, w);
  }
  return w;
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

/** Colours for prompts / agents on the map; picked to stay apart from the status colours' meaning. */
const SOURCE_COLORS = ["#e8a33d", "#e06c9f", "#4fc1c1", "#b394f5", "#c8c86a", "#f0726b", "#7aa2f7", "#9ece6a"];
const PIP = 11;

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

const RISK_W = 24;

const GUIDE_FONT = `italic 12px ${FONT.slice(5)}`;
const GUIDE_MAX = 46;
/** The Guide's line for a folder, shortened to sit next to its pill (the full line is in the tooltip). */
const guideShort = (text: string) => (text.length > GUIDE_MAX ? text.slice(0, GUIDE_MAX - 1).trimEnd() + "…" : text);
// 12px before the line, 12px after it so the branch doesn't touch the text.
const guideWidth = (text: string | undefined) => (text ? 24 + textWidth(guideShort(text), GUIDE_FONT) : 0);

function measure(node: GraphNode, threads: Map<string, number>, news: Map<string, string>, reviewMode: boolean, pips: Map<string, string[]>, risks: Risks | null, guide: Record<string, string> | null): number {
  switch (node.kind) {
    case "root":
      return (
        textWidth(node.name, `700 15px ${FONT.slice(5)}`) + 28 + (node.untouched ? 10 + textWidth(untouchedText(node.untouched), UNTOUCHED) : 0) +
        (risks?.overall.length ? RISK_W : 0)
      );
    case "dir":
      return (
        textWidth(node.name, BOLD) + 10 + textWidth(dirMeta(node.files, reviewMode), SMALL) + (node.collapsed ? 16 : 0) + 26 +
        (node.untouched ? 8 + textWidth(untouchedText(node.untouched), UNTOUCHED) : 0) +
        (node.files.some((f) => news.has(f.path)) ? 12 : 0) +
        guideWidth(guide?.[node.path])
      );
    case "file": {
      const f = node.file;
      let w = 22 + textWidth(node.name, FONT) + 10 + textWidth(statText(f), SMALL);
      if (f.review === "changed") w += 92;
      if (news.get(f.path)) w += newsWidth(news.get(f.path)!) + 8;
      if (threads.get(f.path)) w += 34;
      const p = pips.get(f.path)?.length ?? 0;
      if (p) w += p * PIP + 6;
      if (risks?.files[f.path]) w += RISK_W;
      return w + 14;
    }
    case "ghost":
      return 22 + textWidth(node.name, `italic ${FONT}`);
  }
}

function SourcePanel({ by, sources, onHover }: { by: "prompt" | "agent"; sources: Source[]; onHover: (id: string | null) => void }) {
  return (
    <aside class="summary-panel" aria-label={by === "prompt" ? "Prompts" : "Agents"} onMouseLeave={() => onHover(null)}>
      <div class="summary-item root">
        <div class="summary-head">
          <span>{by === "prompt" ? "By prompt" : "By agent"}</span>
          <span class="muted">{plural(sources.length, by === "prompt" ? "prompt" : "session")}</span>
        </div>
        <p class="muted">
          {sources.length
            ? "Hover one to see just what it touched. Files with more than one dot were changed by more than one."
            : by === "prompt"
              ? "No prompt in this pane's session changed these files."
              : "No agent session found that changed these files."}
        </p>
      </div>
      {sources.map((src, i) => (
        <div key={src.id} class="summary-item source" onMouseEnter={() => onHover(src.id)}>
          <div class="summary-head">
            <span class="source-name">
              <i class="swatch" style={{ background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} />
              <span>{src.detail}</span>
            </span>
            <span class="muted">{src.files.length}</span>
          </div>
          <p>{src.label}</p>
        </div>
      ))}
    </aside>
  );
}

function SummaryPanel(props: {
  folders: string[];
  files: ReviewedFile[];
  summaries: Record<string, Summary | null>;
  pending: Set<string>;
  onSummarize: (folders: string[]) => void;
  onHover: (folder: string | null) => void;
  onPick: (folder: string) => void;
}) {
  const count = (folder: string) => props.files.filter((f) => folder === "" || f.path.startsWith(folder + "/")).length;
  const ask = (folder: string, label: string) => (
    <button
      class="link summarize"
      onClick={(e) => {
        e.stopPropagation();
        props.onSummarize([folder]);
      }}
    >
      {label}
    </button>
  );
  const line = (folder: string) => {
    if (props.pending.has(folder)) return <span class="summary-wait">Summarizing…</span>;
    const s = props.summaries[folder];
    if (!s) return ask(folder, "Summarize");
    return (
      <>
        {s.text}
        {s.stale && (
          <span class="summary-stale">
            {" "}
            · changed since · {ask(folder, "update")}
          </span>
        )}
      </>
    );
  };
  const [root, ...rest] = props.folders;
  return (
    <aside class="summary-panel" aria-label="What changed" onMouseLeave={() => props.onHover(null)}>
      <div class="summary-item root" onMouseEnter={() => props.onHover(root)} onClick={() => props.onPick(root)}>
        <div class="summary-head">
          <span>The whole change</span>
          <span class="muted">{plural(count(root), "file")}</span>
        </div>
        <p>{line(root)}</p>
      </div>
      {rest.map((folder) => {
        const parts = folder.split("/");
        return (
          <div key={folder} class="summary-item" onMouseEnter={() => props.onHover(folder)} onClick={() => props.onPick(folder)}>
            <div class="summary-head">
              <span>
                <span class="muted">{parts.slice(0, -1).map((p) => `${p}/`).join("")}</span>
                <b>{parts[parts.length - 1]}</b>
              </span>
              <span class="muted">{count(folder)}</span>
            </div>
            <p>{line(folder)}</p>
          </div>
        );
      })}
    </aside>
  );
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

export function MapView(props: Props) {
  const { files, allPaths, selected } = props;
  // null until you fold something yourself; then your choice sticks.
  const [savedCollapsed, setCollapsedList] = usePersisted<string[] | null>("mapCollapsed", null);
  const collapsedList = savedCollapsed ?? [];
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const entries = useMemo(() => (allPaths ? entriesByDir(allPaths) : null), [allPaths]);
  const [showLinks, setShowLinks] = usePersisted("mapLinks", false);
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

  // Colour by prompt or by agent: who changed what, with a legend panel.
  const [colourBy, setColourBy] = usePersisted<"off" | "prompt" | "agent">("mapColourBy", "off");
  const [sources, setSources] = useState<Source[]>([]);
  const [hoveredSource, setHoveredSource] = useState<string | null>(null);
  useEffect(() => {
    if (colourBy === "off") return setSources([]);
    let live = true;
    const t = setTimeout(() => {
      api<{ sources: Source[] }>(`/api/repos/${repoId}/sources?scope=${props.scope}&by=${colourBy}`).then((r) => live && setSources(r.sources), () => {});
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filesKey, colourBy, props.scope]);
  const pips = useMemo(() => {
    const m = new Map<string, string[]>();
    sources.forEach((src, i) => src.files.forEach((f) => m.set(f, [...(m.get(f) ?? []), SOURCE_COLORS[i % SOURCE_COLORS.length]])));
    return m;
  }, [sources]);
  // Only dim while hovering an entry that's actually in the current list.
  const hoveredSrc = hoveredSource ? sources.find((x) => x.id === hoveredSource) : undefined;
  const lit = hoveredSrc ? new Set(hoveredSrc.files) : null;
  useEffect(() => setHoveredSource(null), [colourBy]);

  // Guide: what each folder is for, written once by the pane's agent and cached.
  const [showGuide, setShowGuide] = usePersisted("mapGuide", false);
  const [guide, setGuide] = useState<Record<string, string>>({});
  const [guidePending, setGuidePending] = useState<string[]>([]);
  useEffect(() => {
    if (!showGuide) return;
    api<{ folders: Record<string, string>; pending: string[] }>(`/api/repos/${repoId}/guide`).then((g) => {
      setGuide(g.folders);
      setGuidePending(g.pending);
    }, () => {});
    const on = (e: Event) => {
      const g = (e as CustomEvent).detail;
      setGuide(g.folders);
      setGuidePending(g.pending);
    };
    addEventListener("graphdiff:guide", on);
    return () => removeEventListener("graphdiff:guide", on);
  }, [showGuide]);

  // Risk hints: things worth a second look, when you ask for them.
  const [showRisks, setShowRisks] = usePersisted("mapRisks", false);
  const [risks, setRisks] = useState<Risks | null>(null);
  useEffect(() => {
    if (!showRisks) return setRisks(null);
    let live = true;
    const t = setTimeout(() => {
      api<Risks>(`/api/repos/${repoId}/risks?scope=${props.scope}`).then((r) => live && setRisks(r), () => {});
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filesKey, showRisks, props.scope]);
  const riskCount = risks ? Object.keys(risks.files).length + risks.overall.length : 0;

  const ghosts = showLinks && deps ? deps.dependents : [];
  const layout = useMemo(
    () => layoutGraph(props.repoName, files, entries, collapsed, (n) => measure(n, props.threadCounts, props.news, props.reviewMode, pips, risks, showGuide ? guide : null), ghosts),
    [files, entries, collapsed, props.threadCounts, props.repoName, props.news, ghosts, props.reviewMode, pips, risks, showGuide, guide],
  );
  const links = useMemo(() => (showLinks && deps ? placeLinks(layout.nodes, deps) : []), [layout, deps, showLinks]);
  const dirPaths = layout.nodes.flatMap((n) => (n.node.kind === "dir" ? [n.node.path] : []));
  const missingGuide = showGuide ? dirPaths.filter((d) => !(d in guide) && !guidePending.includes(d)) : [];
  const missingKey = missingGuide.join("|");
  useEffect(() => {
    if (!missingGuide.length) return;
    const t = setTimeout(() => {
      api<{ folders: Record<string, string>; pending: string[] }>(`/api/repos/${repoId}/guide`, { body: { folders: missingGuide } }).then((g) => {
        setGuide(g.folders);
        setGuidePending(g.pending);
      }, () => {});
    }, 400);
    return () => clearTimeout(t);
  }, [missingKey]);
  const width = Math.max(layout.width, ...links.map((l) => l.right + 24));
  const focus = hovered ?? selected;
  const pz = usePanZoom();
  const nodeAt = (pred: (n: Placed) => boolean) => layout.nodes.find(pred);

  const maxWeight = Math.max(1, ...layout.nodes.filter((n) => n.node.kind === "file" || n.node.kind === "dir").map((n) => n.weight));
  // Highlight the branch leading to the selected file.
  const [hoveredDir, setHoveredDir] = useState<string | null>(null);
  // A folded folder picked with the keyboard (null when a file is the selection).
  const [focusDir, setFocusDir] = useState<string | null>(null);
  const onPath = new Set<Placed>();
  const dirNode = (path: string) => layout.nodes.find((n) => (path === "" ? n.node.kind === "root" : n.node.kind === "dir" && n.node.path === path));
  const pathStart =
    hoveredDir !== null
      ? dirNode(hoveredDir)
      : focusDir !== null
        ? dirNode(focusDir)
        : layout.nodes.find((n) => n.node.kind === "file" && n.node.path === selected);
  for (let p = pathStart ?? null; p; p = p.parent) onPath.add(p);

  // Folder summaries for the panel: one per folder on the map, plus "" for the whole change.
  const [showSummary, setShowSummary] = usePersisted("mapSummary", false);
  const [summaries, setSummaries] = useState<Record<string, Summary | null>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const folders = useMemo(
    () => ["", ...layout.nodes.filter((n) => n.node.kind === "dir" && n.node.files.length > 0).map((n) => (n.node as { path: string }).path)],
    [layout],
  );
  const foldersKey = folders.join("|");
  // Only ever written when you ask for one; this just loads what's already cached.
  const fetchSummaries = (generate: string[] = []) =>
    api<{ summaries: Record<string, Summary | null> }>(`/api/repos/${repoId}/summaries`, { body: { scope: props.scope, folders, generate } }).then(
      (r) => setSummaries((cur) => ({ ...cur, ...r.summaries })),
      () => {},
    );
  const summarize = (targets: string[]) => {
    setPending((cur) => new Set([...cur, ...targets]));
    fetchSummaries(targets);
  };
  useEffect(() => {
    setSummaries({});
    setPending(new Set());
  }, [props.scope]);
  useEffect(() => {
    if (!showSummary || !files.length) return;
    const t = setTimeout(() => fetchSummaries(), 300);
    return () => clearTimeout(t);
  }, [filesKey, foldersKey, showSummary, props.scope]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.scope !== props.scope) return;
      if (d.summary) setSummaries((cur) => ({ ...cur, [d.folder]: d.summary }));
      setPending((cur) => {
        const next = new Set(cur);
        next.delete(d.folder);
        return next;
      });
    };
    addEventListener("graphdiff:summary", on);
    return () => removeEventListener("graphdiff:summary", on);
  }, [props.scope]);

  // Open on the whole shape: fitted when it's taller than the screen, otherwise at
  // full size with the root on the left, vertically centred.
  const placed = useRef(false);
  useEffect(() => {
    const root = layout.nodes[0];
    if (placed.current || !pz.node || !root) return;
    placed.current = true;
    if (layout.height > pz.node.clientHeight) pz.fit(width, layout.height);
    else pz.place(0, root.y, 0, 0.5, false);
  }, [pz.node, layout]);

  // Keyboard selection pans the file into view.
  useEffect(() => {
    const n = nodeAt((n) => n.node.kind === "file" && n.node.path === selected);
    if (n && placed.current) pz.reveal(n.x - 8, n.y - 14, n.width + 16);
  }, [selected]);

  // Keyboard travel follows what's on screen: visible files, and folded folders as
  // single stops. l/Enter unfolds a folder, h folds the one you're in.
  const [enterDir, setEnterDir] = useState<string | null>(null);
  const stops = layout.nodes.filter((n) => n.node.kind === "file" || (n.node.kind === "dir" && n.node.collapsed));
  const pathOf = (n: Placed) => (n.node.kind === "file" || n.node.kind === "dir" ? n.node.path : "");
  const go = (n: Placed) => {
    if (n.node.kind === "dir") setFocusDir(n.node.path);
    else {
      setFocusDir(null);
      props.onSelect(pathOf(n));
    }
    pz.reveal(n.x - 8, n.y - 14, n.width + 16);
  };
  useEffect(() => setFocusDir((d) => (d && nodeAt((n) => n.node.kind === "dir" && n.node.path === d) ? d : null)), [layout]);
  useEffect(() => {
    if (selected && focusDir && !selected.startsWith(focusDir + "/")) setFocusDir(null);
  }, [selected]);
  // After unfolding with the keyboard, land on the first thing inside.
  useEffect(() => {
    if (!enterDir) return;
    const first = stops.find((n) => pathOf(n).startsWith(enterDir + "/"));
    setEnterDir(null);
    if (first) go(first);
  }, [layout]);
  const fold = (dir: Placed | null) => {
    if (!dir || dir.node.kind !== "dir") return;
    if (!dir.node.collapsed) setCollapsedList([...collapsedList, dir.node.path]);
    setFocusDir(dir.node.path);
  };

  useKeys((e) => {
    const i = focusDir !== null ? stops.findIndex((n) => n.node.kind === "dir" && n.node.path === focusDir) : stops.findIndex((n) => n.node.kind === "file" && n.node.path === selected);
    const cur = stops[i];
    if (e.key === "j" || e.key === "k") {
      const next = i === -1 ? stops[0] : stops[i + (e.key === "j" ? 1 : -1)];
      if (next) go(next);
    } else if ((e.key === "l" || e.key === "Enter") && cur?.node.kind === "dir") {
      setEnterDir(cur.node.path);
      toggleDir(cur.node.path);
    } else if (e.key === "Enter" && cur?.node.kind === "file") props.onOpen(cur.node.path);
    else if (e.key === "h" && cur) fold(cur.parent);
    else if (e.key === "=" || e.key === "+") pz.zoomBy(1.2);
    else if (e.key === "-") pz.zoomBy(1 / 1.2);
    else if (e.key === "0") pz.fit(width, layout.height);
    else return;
    e.preventDefault();
  });

  const toggleDir = (path: string) => setCollapsedList(collapsed.has(path) ? collapsedList.filter((p) => p !== path) : [...collapsedList, path]);
  // Folders with no subfolders: collapsing them leaves just the shape of the change.
  const leafDirs = () => {
    const dirs = new Set(files.map((f) => f.path.split("/").slice(0, -1).join("/")).filter(Boolean));
    return [...dirs].filter((d) => ![...dirs].some((o) => o.startsWith(d + "/")));
  };
  const foldersOnly = collapsedList.length > 0;

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
      <div class="map-main">
      <div class="map-canvas">
      <div class="map-tools">
        {props.news.size > 0 && (
          <button class="btn small news-clear" onClick={props.onClearNews} title="Clear the new / updated tags">
            <span class="news-pip-sm" aria-hidden="true" />
            {props.news.size} new · clear
          </button>
        )}
        <button class={`btn small ${showGuide ? "on" : ""}`} onClick={() => setShowGuide(!showGuide)} title="What each folder is for, written by your agent once and kept">
          Guide{showGuide && guidePending.length ? " …" : ""}
        </button>
        <span class="seg-tools" role="group" aria-label="Colour the map by">
          {(["prompt", "agent"] as const).map((by) => (
            <button
              key={by}
              class={`btn small ${colourBy === by ? "on" : ""}`}
              title={by === "prompt" ? "Colour files by the prompt that changed them" : "Colour files by the agent session that changed them"}
              onClick={() => {
                setColourBy(colourBy === by ? "off" : by);
                if (colourBy !== by) setShowSummary(false);
              }}
            >
              {by === "prompt" ? "Prompts" : "Agents"}
            </button>
          ))}
        </span>
        <button class={`btn small ${showSummary ? "on" : ""}`} onClick={() => { setShowSummary(!showSummary); if (!showSummary) setColourBy("off"); }} title="One-line summaries of what changed in each folder">
          Summary
        </button>
        <button class={`btn small ${showRisks ? "on" : ""} ${showRisks && riskCount ? "warn" : ""}`} onClick={() => setShowRisks(!showRisks)} title="Flag things worth a second look: rewrites, big changes, broken imports, no tests">
          Risks{showRisks && risks ? ` · ${riskCount}` : ""}
        </button>
        <button class={`btn small ${showLinks ? "on" : ""}`} onClick={() => setShowLinks(!showLinks)} title="Show which changed files import each other, and unchanged files that use them">
          Imports
        </button>
        <button class={`btn small ${foldersOnly ? "on" : ""}`} onClick={() => setCollapsedList(foldersOnly ? [] : leafDirs())} title="Hide files and show just which folders changed">
          {foldersOnly ? "Show files" : "Folders only"}
        </button>
        <span class="zoom">
          <button class="btn small" onClick={() => pz.zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)">−</button>
          <button class="btn small" onClick={pz.reset} title="Actual size">{Math.round(pz.zoom * 100)}%</button>
          <button class="btn small" onClick={() => pz.zoomBy(1.2)} aria-label="Zoom in" title="Zoom in (+)">+</button>
          <button class="btn small" onClick={() => pz.fit(width, layout.height)} title="Fit everything (0)">Fit</button>
        </span>
      </div>
      <div class={`map-scroll ${pz.dragging ? "dragging" : ""}`} ref={pz.ref}>
        {/* The layer is what moves (a CSS transform the browser composites); the
            map inside is drawn at its natural size and isn't re-rendered while you pan. */}
        <div class="map-layer" ref={pz.layerRef}>
        <svg
          class={`graph ${hovered ? "hovering" : ""} ${lit ? "sourcing" : ""}`}
          width={width}
          height={layout.height}
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
              if (!n.parent || n.block) return null;
              const p = n.parent;
              const x1 = p.x + p.width;
              const x2 = n.x;
              const mid = (x1 + x2) / 2;
              const files = n.node.kind === "dir" ? n.node.files : [];
              const allDone = props.reviewMode && files.length > 0 && done(files) === files.length;
              const d = `M${x1},${p.y} C${mid},${p.y} ${mid},${n.y} ${x2},${n.y}`;
              return (
                <path
                  key={n.node.id}
                  class={`edge ${allDone ? "done" : ""} ${onPath.has(n) ? "hot" : ""}`}
                  d={d}
                  // As a CSS property too, so browsers that can animate it glide with the nodes.
                  style={{ d: `path("${d}")` }}
                  stroke-width={1.5 + 5 * Math.sqrt(n.weight / maxWeight)}
                />
              );
            })}
            {layout.blocks.map((b) => {
              // The branch curves into the middle of the block's left edge; the box does the grouping.
              // A one-file folder has no box, so its branch runs straight to the file.
              const p = b.parent;
              const x1 = p.x + p.width;
              const boxed = b.rows.length > 1;
              const midY = (b.rows[0] + b.rows[b.rows.length - 1]) / 2;
              const x2 = boxed ? b.x + 6 : b.items[0].x;
              const mid = (x1 + x2) / 2;
              const changed = b.items.flatMap((it) => (it.node.kind === "file" ? [it.node.file] : []));
              const allDone = props.reviewMode && changed.length > 0 && done(changed) === changed.length;
              const hot = b.items.some((it) => onPath.has(it));
              const branch = `M${x1},${p.y} C${mid},${p.y} ${mid},${midY} ${x2},${midY}`;
              return (
                <g key={`b:${p.node.id}`} class={`comb ${hot ? "hot" : ""} ${allDone ? "done" : ""}`}>
                  {boxed && (
                    <rect class="block-bg" x={b.x + 6} y={b.rows[0] - 19} width={b.right - b.x + 10} height={b.rows[b.rows.length - 1] - b.rows[0] + 38} rx={12} />
                  )}
                  <path class={`edge ${hot ? "hot" : ""} ${allDone ? "done" : ""}`} d={branch} style={{ d: `path("${branch}")` }} stroke-width={1.5 + 5 * Math.sqrt(b.weight / maxWeight)} />
                  {boxed && <circle class="block-port" cx={x2} cy={midY} r={3.5} />}
                </g>
              );
            })}
          </g>
          <g class="dep-links">
            {links.map((l) => {
              const hot = !!focus && (l.fromPath === focus || l.toPath === focus);
              return (
                <path key={l.id} class={`dep-link ${hot ? "hot" : ""}`} d={l.d} style={{ d: `path("${l.d}")` }} marker-end={`url(#${hot ? "arrow-hot" : "arrow"})`}>
                  <title>
                    {l.fromLabel} imports {l.toLabel}
                  </title>
                </path>
              );
            })}
          </g>
          {layout.nodes.map((n) => (
            <Node
              key={n.node.id}
              placed={n}
              {...props}
              selected={focusDir !== null ? null : selected}
              focused={n.node.kind === "dir" && n.node.path === focusDir}
              pips={n.node.kind === "file" ? pips.get(n.node.path) : undefined}
              risk={n.node.kind === "file" ? risks?.files[n.node.path] : n.node.kind === "root" && risks?.overall.length ? risks.overall : undefined}
              guide={showGuide && n.node.kind === "dir" ? (guide[n.node.path] ?? (guidePending.includes(n.node.path) ? "" : undefined)) : undefined}
              lit={!lit || (n.node.kind === "file" ? lit.has(n.node.path) : n.node.kind === "dir" || n.node.kind === "root" ? n.node.files.some((f) => lit.has(f.path)) : false)}
              onPath={onPath.has(n)}
              onToggle={toggleDir}
            />
          ))}
        </svg>
        </div>
      </div>
      </div>
      {colourBy !== "off" && (
        <SourcePanel by={colourBy} sources={sources} onHover={setHoveredSource} />
      )}
      {showSummary && (
        <SummaryPanel
          folders={folders}
          files={files}
          summaries={summaries}
          onHover={setHoveredDir}
          pending={pending}
          onSummarize={summarize}
          onPick={(folder) => {
            const n = nodeAt((n) => (folder === "" ? n.node.kind === "root" : n.node.kind === "dir" && n.node.path === folder));
            if (n) pz.place(n.x, n.y, 0.3, 0.5);
          }}
        />
      )}
      </div>

    </div>
  );
}

type NodeProps = Props & { placed: Placed; onPath: boolean; onToggle: (path: string) => void; focused?: boolean; pips?: string[]; lit?: boolean; risk?: string[]; guide?: string };

/** A small warning triangle; the reasons show on hover. */
function RiskMark({ x, y, reasons }: { x: number; y: number; reasons: string[] }) {
  return (
    <g class="risk" transform={`translate(${x}, ${y})`}>
      <title>{reasons.join("\n")}</title>
      <path d="M8 -7 L15.5 6.5 H0.5 Z" />
      <path class="bang" d="M8 -2.5 V2 M8 4.3 V4.4" />
    </g>
  );
}

/**
 * Positions a node with a CSS transform so it glides when the layout reflows (a new
 * file pushes the rest down) instead of jumping; the body draws at the origin.
 */
function Node(props: NodeProps) {
  const p = props.placed;
  return (
    <g class={`gpos ${props.lit === false ? "dim" : ""}`} style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
      <NodeBody {...props} placed={{ ...p, x: 0, y: 0 }} />
    </g>
  );
}

function NodeBody(props: NodeProps) {
  const { placed: p } = props;
  const n = p.node;
  const top = p.y - 12;

  if (n.kind === "root" || n.kind === "dir") {
    const d = done(n.files);
    const all = d === n.files.length;
    const meta = n.kind === "dir" ? dirMeta(n.files, props.reviewMode) : "";
    const nameW = textWidth(n.name, n.kind === "root" ? `700 15px ${FONT.slice(5)}` : BOLD);
    // The measured width includes the Guide line, which sits outside the pill.
    const pillW = p.width - (props.guide ? guideWidth(props.guide) : 0);
    return (
      <g
        class={`gnode ${n.kind} ${props.focused ? "focused" : ""} ${n.files.length === 0 ? "context" : all && props.reviewMode ? "all-done" : ""} ${props.onPath ? "hot" : ""} ${n.kind === "dir" && n.collapsed ? "collapsed" : ""}`}
        onClick={() => n.kind === "dir" && props.onToggle(n.path)}
        data-dir={n.kind === "dir" ? n.path : ""}
        role="treeitem"
        aria-expanded={n.kind === "dir" ? !n.collapsed : true}
      >
        <title>
          {n.kind === "dir" ? `${n.path}\n` : ""}
          {props.guide ? `${props.guide}\n` : ""}
          {plural(n.files.length, "changed file")}
          {props.reviewMode ? `, ${d} reviewed` : ""}
          {n.kind === "dir" ? `\nClick to ${n.collapsed ? "expand" : "collapse"}` : ""}
        </title>
        <rect x={p.x} y={top} width={pillW} height={24} rx={12} />
        {/* Review progress along the bottom of the pill. */}
        {props.reviewMode && <rect class="pill-progress" x={p.x + 10} y={top + 20} width={n.files.length ? Math.max(0, (p.width - 20) * (d / n.files.length)) : 0} height={2} rx={1} />}
        <text x={p.x + 13} y={p.y + 4.5} class="pill-name">
          {n.name}
        </text>
        {n.kind === "dir" && (
          <text x={p.x + 13 + nameW + 10} y={p.y + 4} class="pill-meta">
            {meta}
            {n.collapsed ? " ▸" : ""}
            {n.untouched > 0 && <tspan class="pill-untouched" dx="8">{untouchedText(n.untouched)}</tspan>}
          </text>
        )}
        {n.kind === "root" && props.risk && <RiskMark x={p.x + p.width - RISK_W + 2} y={p.y} reasons={props.risk} />}
        {n.kind === "root" && n.untouched > 0 && (
          <text x={p.x + 14 + nameW + 10} y={p.y + 4.5} class="pill-untouched">
            {untouchedText(n.untouched)}
          </text>
        )}
        {n.kind === "dir" && n.files.some((f) => props.news.has(f.path)) && (
          <circle cx={p.x + pillW - 11} cy={p.y} r={3.5} class="news-pip">
            <title>Something here is new since you last looked</title>
          </circle>
        )}
        {props.guide && (
          <text x={p.x + pillW + 12} y={p.y + 4} class="guide-text">
            {guideShort(props.guide)}
          </text>
        )}
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
      {props.risk && <RiskMark x={extraX + (threads > 0 ? 34 : 0) + (props.pips?.length ? props.pips.length * PIP + 6 : 0)} y={p.y} reasons={props.risk} />}
      {props.pips && props.pips.length > 0 &&
        (() => {
          const x = extraX + (threads > 0 ? 34 : 0);
          return (
            <g class="pips">
              {props.pips.map((c, i) => (
                <circle key={i} cx={x + 5 + i * PIP} cy={p.y} r={4.5} fill={c} />
              ))}
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
