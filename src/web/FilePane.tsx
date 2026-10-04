import { useEffect, useMemo, useState } from "preact/hooks";
import type { Anchor, Thread } from "../server/ask.ts";
import type { DiffLine } from "../server/diff.ts";
import type { FileDiff } from "../server/fileDiff.ts";
import type { Scope } from "../server/git.ts";
import type { ReviewedFile } from "../server/review.ts";
import { api, repoId } from "./api.ts";
import { DiffView, lineKey, type ViewMode } from "./DiffView.tsx";
import { useKeys } from "./hooks.ts";
import { anchorLabel, Composer, ThreadCard, type Target } from "./Threads.tsx";
import { Check } from "./icons.tsx";
import { DiffStat, StatusBadge } from "./Tree.tsx";
import { WhyPanel } from "./WhyPanel.tsx";
import { ago } from "./util.ts";

export const modes: { id: ViewMode; label: string }[] = [
  { id: "unified", label: "Unified" },
  { id: "split", label: "Split" },
  { id: "full", label: "Full file" },
];

export interface AskRequest {
  path: string;
  anchor: Anchor | null;
  code: string;
  question: string;
  target: Target;
}

interface Props {
  file: ReviewedFile;
  scope: Scope;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  onReview: (reviewed: boolean) => void;
  threads: Thread[];
  agent: string | null;
  onAsk: (req: AskRequest) => Promise<void>;
  onReply: (thread: Thread, question: string, target: Target) => Promise<void>;
  onDeleteThread: (thread: Thread) => void;
  onBack: () => void;
}

/** Turns selected diff lines into an anchor (new-side numbers when there are any) and their text. */
function selectionAnchor(lines: DiffLine[]): { anchor: Anchor; code: string } | null {
  if (!lines.length) return null;
  const news = lines.filter((l) => l.n !== null).map((l) => l.n!);
  const olds = lines.filter((l) => l.o !== null).map((l) => l.o!);
  const anchor: Anchor = news.length
    ? { side: "new", start: Math.min(...news), end: Math.max(...news) }
    : { side: "old", start: Math.min(...olds), end: Math.max(...olds) };
  return { anchor, code: lines.map((l) => (l.t === " " ? " " : l.t) + l.s).join("\n") };
}

export function FilePane({ file, scope, mode, setMode, onReview, threads, agent, onAsk, onReply, onDeleteThread, onBack }: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlySinceReview, setOnlySinceReview] = useState(false);
  const since = onlySinceReview && file.review === "changed";
  const full = mode === "full" && !since;
  // Refetch when the file itself changes on disk, not just when another one is picked.
  const version = `${file.path}|${file.mtime}|${file.added}|${file.deleted}|${file.review}`;

  const [sel, setSel] = useState<{ anchor: string; focus: string } | null>(null);
  const [focusComposer, setFocusComposer] = useState(0);

  useEffect(() => {
    setOnlySinceReview(false);
    setSel(null);
  }, [file.path]);

  const lines = useMemo(() => diff?.hunks.flatMap((h) => h.lines) ?? [], [diff]);
  const selectedLines = useMemo(() => {
    if (!sel) return [];
    const a = lines.findIndex((l) => lineKey(l) === sel.anchor);
    const b = lines.findIndex((l) => lineKey(l) === sel.focus);
    if (a === -1 || b === -1) return [];
    return lines.slice(Math.min(a, b), Math.max(a, b) + 1);
  }, [sel, lines]);
  const selection = selectionAnchor(selectedLines);
  const selectedKeys = useMemo(() => new Set(selectedLines.map(lineKey)), [selectedLines]);

  useKeys((e) => {
    if (e.key === "a") setFocusComposer((n) => n + 1);
    else if (e.key === "Escape" && sel) setSel(null);
    else return;
    e.preventDefault();
  });

  const interaction = {
    selected: selectedKeys,
    onLine: (l: DiffLine, extend: boolean) => {
      const k = lineKey(l);
      setSel(extend && sel ? { anchor: sel.anchor, focus: k } : sel?.anchor === k && sel.focus === k ? null : { anchor: k, focus: k });
      setFocusComposer((n) => n + 1);
    },
    threads,
    renderThread: (t: Thread, outdated: boolean) => (
      <ThreadCard thread={t} agent={agent} showCode={outdated} onReply={(q, target) => onReply(t, q, target)} onDelete={() => onDeleteThread(t)} />
    ),
  };

  useEffect(() => {
    let live = true;
    setError(null);
    const q = `scope=${scope}&path=${encodeURIComponent(file.path)}`;
    const url = since ? `/api/repos/${repoId}/since-review?${q}` : `/api/repos/${repoId}/diff?${q}${full ? "&full=1" : ""}`;
    api<FileDiff>(url).then(
      (d) => live && setDiff(d),
      (e) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [version, scope, full, since]);

  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const stale = diff?.file.path !== file.path;
  return (
    <>
      <div class="file-head">
        <button class="back" onClick={onBack} title="Back to the map (g)">
          ← Map
        </button>
        <StatusBadge file={file} />
        <span class="file-path">
          <span class="muted">{dir}</span>
          {file.path.slice(dir.length)}
        </span>
        {file.oldPath && <span class="muted from">from {file.oldPath}</span>}
        <DiffStat file={file} />
        <div class="spacer" />
        <div class="segmented small" role="tablist" aria-label="Diff view">
          {modes.map((m, i) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} class={mode === m.id ? "on" : ""} title={`${m.label} (${i + 1})`} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <ReviewButton file={file} onReview={onReview} />
      </div>

      {file.review === "changed" && (
        <div class="banner warn">
          <span>
            <b>Edited again</b> since you reviewed it {file.reviewedAt && ago(file.reviewedAt)}.
          </span>
          <button class="link" onClick={() => setOnlySinceReview(!onlySinceReview)}>
            {onlySinceReview ? "Show the whole change" : "Show only what changed since then"}
          </button>
        </div>
      )}

      <WhyPanel path={file.path} scope={scope} version={version} />

      {error ? (
        <div class="diff-note">{error}</div>
      ) : !diff || stale ? (
        <div class="diff-note muted">Loading…</div>
      ) : (
        <DiffView diff={diff} mode={since && mode === "full" ? "unified" : mode} onFullFile={() => setMode("full")} interaction={interaction} />
      )}

      <div class="ask-bar">
        <div class="ask-target">
          {selection ? (
            <>
              Asking about <b>{anchorLabel(selection.anchor)}</b>
              <button class="link" onClick={() => setSel(null)}>clear</button>
            </>
          ) : (
            <>Asking about <b>this file</b> <span class="muted">· click line numbers to pick lines · <kbd>a</kbd> to type</span></>
          )}
        </div>
        <Composer
          label={selection ? anchorLabel(selection.anchor) : "this file"}
          agent={agent}
          focusKey={focusComposer || undefined}
          onCancel={() => setSel(null)}
          onAsk={async (question, target) => {
            await onAsk({ path: file.path, anchor: selection?.anchor ?? null, code: selection?.code ?? "", question, target });
            setSel(null);
          }}
        />
      </div>
    </>
  );
}

function ReviewButton({ file, onReview }: { file: ReviewedFile; onReview: (reviewed: boolean) => void }) {
  if (file.review === "reviewed") {
    return (
      <button class="btn reviewed" onClick={() => onReview(false)} title="Mark as not reviewed (space)">
        <Check /> Reviewed
      </button>
    );
  }
  return (
    <button class="btn primary" onClick={() => onReview(true)} title="Mark reviewed and go to the next file (space)">
      Mark reviewed <kbd>space</kbd>
    </button>
  );
}
