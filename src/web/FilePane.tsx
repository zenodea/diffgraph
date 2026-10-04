import { useEffect, useState } from "preact/hooks";
import type { FileDiff } from "../server/fileDiff.ts";
import type { Scope } from "../server/git.ts";
import type { ReviewedFile } from "../server/review.ts";
import { api, repoId } from "./api.ts";
import { DiffView, type ViewMode } from "./DiffView.tsx";
import { Check } from "./icons.tsx";
import { DiffStat, StatusBadge } from "./Tree.tsx";
import { WhyPanel } from "./WhyPanel.tsx";
import { ago } from "./util.ts";

export const modes: { id: ViewMode; label: string }[] = [
  { id: "unified", label: "Unified" },
  { id: "split", label: "Split" },
  { id: "full", label: "Full file" },
];

interface Props {
  file: ReviewedFile;
  scope: Scope;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  onReview: (reviewed: boolean) => void;
}

export function FilePane({ file, scope, mode, setMode, onReview }: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlySinceReview, setOnlySinceReview] = useState(false);
  const since = onlySinceReview && file.review === "changed";
  const full = mode === "full" && !since;
  // Refetch when the file itself changes on disk, not just when another one is picked.
  const version = `${file.path}|${file.mtime}|${file.added}|${file.deleted}|${file.review}`;

  useEffect(() => setOnlySinceReview(false), [file.path]);

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
        <DiffView diff={diff} mode={since && mode === "full" ? "unified" : mode} onFullFile={() => setMode("full")} />
      )}
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
