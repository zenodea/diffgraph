import type { ReviewedFile } from "../../server/review/review.ts";

type ChangedFile = ReviewedFile;

export interface TreeNode {
  name: string;
  /** Full path; for a compacted dir like "src/lib", the deepest dir's path. */
  path: string;
  dir: boolean;
  children: TreeNode[];
  file?: ChangedFile;
  /** Changed files at or below this node. */
  changed: ChangedFile[];
}

/**
 * Builds a tree of `paths`, attaching change info, then folds single-child dir chains
 * ("src" → "lib") into one row ("src/lib") so deep paths don't eat the screen.
 */
export function buildTree(paths: string[], changes: Map<string, ChangedFile>): TreeNode {
  const root: TreeNode = { name: "", path: "", dir: true, children: [], changed: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1;
      const sub = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.path === sub && c.dir === !leaf);
      if (!child) {
        child = { name: parts[i], path: sub, dir: !leaf, children: [], changed: [] };
        if (leaf) child.file = changes.get(path);
        node.children.push(child);
      }
      node = child;
    }
  }
  finish(root);
  return root;
}

function finish(node: TreeNode): void {
  for (const c of node.children) finish(c);
  node.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  node.changed = node.file ? [node.file] : node.children.flatMap((c) => c.changed);
  // Fold "a" → "b" when a dir's only child is a dir.
  node.children = node.children.map((c) => {
    while (c.dir && c.children.length === 1 && c.children[0].dir) {
      const only = c.children[0];
      c = { ...only, name: `${c.name}/${only.name}` };
    }
    return c;
  });
}

/** Changed files in the order the tree shows them (for j/k and "next"). */
export function visibleOrder(node: TreeNode, collapsed: Set<string>): ChangedFile[] {
  const out: ChangedFile[] = [];
  const walk = (n: TreeNode) => {
    if (n.file) out.push(n.file);
    if (n.dir && (n === node || !collapsed.has(n.path))) n.children.forEach(walk);
  };
  walk(node);
  return out;
}
