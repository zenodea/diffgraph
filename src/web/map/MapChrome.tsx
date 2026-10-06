// The bits around the map: the "Show" menu that holds the optional layers, and the
// hover card that explains whatever is under the pointer.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ReviewedFile } from "../../server/review/review.ts";
import { changedShare } from "../../shared.ts";
import { plural } from "../lib/util.ts";

type ColourBy = "off" | "prompt" | "agent";

interface MenuProps {
  colourBy: ColourBy;
  setColourBy: (v: ColourBy) => void;
  showSummary: boolean;
  setShowSummary: (v: boolean) => void;
  showRisks: boolean;
  setShowRisks: (v: boolean) => void;
  riskCount: number | null;
  showLinks: boolean;
  setShowLinks: (v: boolean) => void;
}

/** One button for the map's optional layers, so the toolbar stays short. */
export function ShowMenu(p: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", close);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", esc);
    };
  }, [open]);

  const active = [p.showLinks, p.showRisks, p.showSummary, p.colourBy !== "off"].filter(Boolean).length;
  const toggle = (label: string, hint: string, on: boolean, set: () => void, extra?: string) => (
    <button class={`menu-item ${on ? "on" : ""}`} role="menuitemcheckbox" aria-checked={on} onClick={set}>
      <span class="menu-check" aria-hidden="true">{on ? "✓" : ""}</span>
      <span class="menu-text">
        <span class="menu-label">
          {label}
          {extra && <span class="menu-extra">{extra}</span>}
        </span>
        <span class="menu-hint">{hint}</span>
      </span>
    </button>
  );
  return (
    <div class="show-menu" ref={ref}>
      <button class={`btn small ${active ? "on" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Show{active ? ` · ${active}` : ""} <span class="caret-down" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div class="menu" role="menu">
          {toggle("Imports", "What a file uses and what uses it, on hover", p.showLinks, () => p.setShowLinks(!p.showLinks))}
          {toggle("Risks", "Rewrites, big changes, broken imports, no tests", p.showRisks, () => p.setShowRisks(!p.showRisks), p.riskCount ? `${p.riskCount}` : undefined)}
          {toggle("Summary", "One line on what changed, per folder", p.showSummary, () => p.setShowSummary(!p.showSummary))}
          <div class="menu-sep" />
          <div class="menu-heading">Colour files by</div>
          {toggle("Prompt", "Which of your prompts changed each file", p.colourBy === "prompt", () => p.setColourBy(p.colourBy === "prompt" ? "off" : "prompt"))}
          {toggle("Agent", "Which agent session changed each file", p.colourBy === "agent", () => p.setColourBy(p.colourBy === "agent" ? "off" : "agent"))}
        </div>
      )}
    </div>
  );
}

const statusWord: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

interface CardProps {
  card: { kind: "dir" | "file"; path: string; x: number; y: number; below: boolean };
  files: ReviewedFile[];
  guide: Record<string, string>;
  guidePending: string[];
  untouched: number;
  reviewMode: boolean;
  risks?: string[];
  threads: number;
  news?: string;
}

/** What's under the pointer: a folder's role (from the Guide) and size, or a file's change. */
export function HoverCard({ card, files, guide, guidePending, untouched, reviewMode, risks, threads, news }: CardProps) {
  const style = { left: `${Math.max(8, card.x)}px`, top: `${card.y}px`, transform: card.below ? "none" : "translateY(-100%)" };
  const role = (folder: string) =>
    guide[folder] ? <p class="card-role">{guide[folder]}</p> : guidePending.includes(folder) ? <p class="card-role pending">Working out what this folder is for…</p> : null;

  if (card.kind === "dir") {
    const inside = files.filter((f) => f.path.startsWith(card.path + "/"));
    const added = inside.reduce((n, f) => n + f.added, 0);
    const deleted = inside.reduce((n, f) => n + f.deleted, 0);
    const done = inside.filter((f) => f.review === "reviewed").length;
    return (
      <div class="hover-card" style={style} role="tooltip">
        <div class="card-path">
          <span class="card-icon" aria-hidden="true">▦</span>
          {card.path}/
        </div>
        {role(card.path)}
        <div class="card-stats">
          <span>{plural(inside.length, "changed file")}</span>
          {added > 0 && <span class="plus">+{added}</span>}
          {deleted > 0 && <span class="minus">−{deleted}</span>}
          {untouched > 0 && <span class="muted">{untouched} untouched</span>}
          {reviewMode && <span class="muted">{done}/{inside.length} reviewed</span>}
        </div>
        <div class="card-hint">Click to fold or unfold</div>
      </div>
    );
  }

  const f = files.find((x) => x.path === card.path);
  const folder = card.path.split("/").slice(0, -1).join("/");
  if (!f) {
    // An unchanged file shown because it imports a changed one.
    return (
      <div class="hover-card" style={style} role="tooltip">
        <div class="card-path">{card.path}</div>
        <p class="card-role">Not changed, but it imports a file that was.</p>
      </div>
    );
  }
  const share = changedShare(f);
  return (
    <div class="hover-card" style={style} role="tooltip">
      <div class="card-path">
        <span class={`card-dot s-${f.status}`} aria-hidden="true" />
        <span class="card-name">{card.path.split("/").pop()}</span>
        {news && <span class="news-tag">{news}</span>}
      </div>
      <div class="card-stats">
        <span>{statusWord[f.status] ?? "changed"}</span>
        {!f.binary && f.added > 0 && <span class="plus">+{f.added}</span>}
        {!f.binary && f.deleted > 0 && <span class="minus">−{f.deleted}</span>}
        {f.status === "M" && <span class="muted">about {Math.max(1, Math.round(share * 100))}% of the file</span>}
        {threads > 0 && <span class="muted">{plural(threads, "question")}</span>}
      </div>
      {reviewMode && f.review === "changed" && <p class="card-warn">Edited again since you reviewed it</p>}
      {risks?.map((r) => (
        <p key={r} class="card-warn">⚠ {r}</p>
      ))}
      {folder && (
        <div class="card-folder">
          <span class="muted">in {folder}/</span>
          {guide[folder] && <span> · {guide[folder]}</span>}
        </div>
      )}
      <div class="card-hint">Click to open the diff</div>
    </div>
  );
}
