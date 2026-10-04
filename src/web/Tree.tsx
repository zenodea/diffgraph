import type { ChangedFile } from "../server/git.ts";
import type { ReviewedFile } from "../server/review.ts";
import { Check } from "./icons.tsx";
import type { TreeNode } from "./tree.ts";

interface Props {
  root: TreeNode;
  selected: string | null;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onReview: (files: ReviewedFile[], reviewed: boolean) => void;
  /** Reviewed files are filtered out, so folder counts show what's left instead. */
  hideReviewed: boolean;
  /** When the watcher last saw each path change (ms). */
  recent: Map<string, number>;
  threadCounts: Map<string, number>;
}

const FRESH_MS = 2 * 60_000;

export function Tree(props: Props) {
  return (
    <div class="tree" role="tree">
      {props.root.children.map((n) => (
        <Node key={n.path + n.dir} node={n} depth={0} {...props} />
      ))}
    </div>
  );
}

function Node(props: Props & { node: TreeNode; depth: number }) {
  const { node, depth } = props;
  const pad = { paddingLeft: `${6 + depth * 14}px` };

  if (!node.dir) {
    const f = node.file;
    const selected = props.selected === node.path;
    const seen = props.recent.get(node.path) ?? 0;
    const touched = Math.max(seen, f?.mtime ?? 0);
    const fresh = !!f && Date.now() - touched < FRESH_MS;
    const cls = ["row", "file", f ? "changed" : "unchanged", selected && "selected", f?.status === "D" && "deleted", f?.review && `r-${f.review}`];
    return (
      <div
        // Re-keying on each watcher hit restarts the flash animation.
        key={seen}
        class={[...cls, seen && Date.now() - seen < 3000 && "flash"].filter(Boolean).join(" ")}
        style={pad}
        role="treeitem"
        aria-selected={selected}
        data-path={node.path}
        onClick={() => f && props.onSelect(node.path)}
      >
        {f ? <ReviewCircle files={[f]} onReview={props.onReview} /> : <span class="circle-spacer" />}
        {f ? <StatusBadge file={f} /> : <span class="badge-spacer" />}
        <span class="name" title={node.path}>
          {node.name}
          {f?.oldPath && <span class="renamed-from"> ← {f.oldPath.split("/").pop()}</span>}
        </span>
        {f?.review === "changed" && <span class="again" title="Edited again after you reviewed it">edited again</span>}
        {props.threadCounts.get(node.path) ? (
          <span class="q-count" title={`${props.threadCounts.get(node.path)} questions asked here`}>
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>
            {props.threadCounts.get(node.path)}
          </span>
        ) : null}
        {fresh && <span class="fresh" title="Changed in the last 2 minutes" />}
        {f && <DiffStat file={f} />}
      </div>
    );
  }

  const open = !props.collapsed.has(node.path);
  const changed = node.changed;
  const done = changed.filter((f) => f.review === "reviewed").length;
  return (
    <>
      <div class={`row dir ${changed.length ? "changed" : "unchanged"} ${changed.length && done === changed.length ? "r-reviewed" : ""}`} style={pad} role="treeitem" aria-expanded={open} onClick={() => props.onToggle(node.path)}>
        {changed.length ? <ReviewCircle files={changed} onReview={props.onReview} /> : <span class="circle-spacer" />}
        <span class={`chevron ${open ? "open" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        <span class="name">{node.name}</span>
        {changed.length > 0 && (
          <span class="dir-count" title={`${done} of ${changed.length} reviewed`}>
            {props.hideReviewed ? `${changed.length - done} left` : `${done}/${changed.length}`}
          </span>
        )}
      </div>
      {open && node.children.map((c) => <Node key={c.path + c.dir} {...props} node={c} depth={depth + 1} />)}
    </>
  );
}

/** One click marks a file (or everything in a folder) reviewed; again to undo. */
function ReviewCircle({ files, onReview }: { files: ReviewedFile[]; onReview: Props["onReview"] }) {
  const done = files.every((f) => f.review === "reviewed");
  const again = files.some((f) => f.review === "changed");
  const some = !done && files.some((f) => f.review === "reviewed");
  const label = files.length > 1 ? (done ? "Mark folder not reviewed" : "Mark whole folder reviewed") : done ? "Mark not reviewed" : "Mark reviewed";
  return (
    <button
      class={`circle ${done ? "done" : again ? "again" : some ? "some" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={done}
      onClick={(e) => {
        e.stopPropagation();
        onReview(files, !done);
      }}
    >
      {done && <Check />}
    </button>
  );
}

const statusLabel: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

export function StatusBadge({ file }: { file: ChangedFile }) {
  const s = file.status;
  return (
    <span class={`badge s-${s}`} title={file.untracked ? "new, not yet added to git" : statusLabel[s]}>
      {s}
    </span>
  );
}

export function DiffStat({ file }: { file: Pick<ChangedFile, "added" | "deleted" | "binary"> }) {
  if (file.binary) return <span class="stat"><span class="bin">bin</span></span>;
  return (
    <span class="stat">
      {file.added > 0 && <span class="plus">+{file.added}</span>}
      {file.deleted > 0 && <span class="minus">−{file.deleted}</span>}
    </span>
  );
}
