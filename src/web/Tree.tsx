import type { ChangedFile } from "../server/git.ts";
import type { TreeNode } from "./tree.ts";

interface Props {
  root: TreeNode;
  selected: string | null;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

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
  const pad = { paddingLeft: `${8 + depth * 14}px` };

  if (!node.dir) {
    const f = node.file;
    const selected = props.selected === node.path;
    return (
      <div
        class={`row file ${f ? "changed" : "unchanged"} ${selected ? "selected" : ""} ${f?.status === "D" ? "deleted" : ""}`}
        style={pad}
        role="treeitem"
        aria-selected={selected}
        data-path={node.path}
        onClick={() => f && props.onSelect(node.path)}
      >
        {f ? <StatusBadge file={f} /> : <span class="badge-spacer" />}
        <span class="name" title={node.path}>
          {node.name}
          {f?.oldPath && <span class="renamed-from"> ← {f.oldPath.split("/").pop()}</span>}
        </span>
        {f && <DiffStat file={f} />}
      </div>
    );
  }

  const open = !props.collapsed.has(node.path);
  const changed = node.changed;
  return (
    <>
      <div
        class={`row dir ${changed.length ? "changed" : "unchanged"}`}
        style={pad}
        role="treeitem"
        aria-expanded={open}
        onClick={() => props.onToggle(node.path)}
      >
        <span class={`chevron ${open ? "open" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        <span class="name">{node.name}</span>
        {changed.length > 0 && <span class="dir-count">{changed.length}</span>}
      </div>
      {open && node.children.map((c) => <Node key={c.path + c.dir} {...props} node={c} depth={depth + 1} />)}
    </>
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
