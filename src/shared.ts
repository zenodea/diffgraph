// Constants shared by the server and the page (no Node imports here).

/** git's empty tree: the "before" of a repo with no commits. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Roughly how much of a file the change touched, 0–1: changed lines over the union of
 * old and new lines. New and deleted files count as fully changed.
 */
export function changedShare(f: { status: string; added: number; deleted: number; lines: number | null; binary: boolean }): number {
  if (f.status === "A" || f.status === "D") return 1;
  if (f.binary || f.lines === null) return 1;
  const total = f.lines + f.deleted;
  return total ? Math.min(1, (f.added + f.deleted) / total) : 0;
}
