import { useEffect, useMemo, useState } from "preact/hooks";
import type { Scope } from "../server/git.ts";
import type { ReviewedFile } from "../server/review.ts";
import { repoId } from "./api.ts";

export type NewsKind = "new" | "updated";

export interface News {
  /** Files that appeared or changed since you last acknowledged them. */
  files: Map<string, NewsKind>;
  /** Files that were changed last time and aren't any more (reverted or committed away). */
  gone: number;
  /** Acknowledge some files, or everything when called without paths. */
  ack: (paths?: string[]) => void;
}

const sig = (f: ReviewedFile) => `${f.status}:${f.added}:${f.deleted}:${f.mtime ?? ""}`;

/**
 * "What's new since I last looked", kept per repo and scope in this browser.
 * The baseline only moves when you acknowledge: opening a file acknowledges it,
 * "Got it" acknowledges everything. So whatever the agent did while you were
 * away is waiting when you come back, and nothing is cleared before you've seen it.
 */
export function useNews(files: ReviewedFile[] | null, scope: Scope): News {
  const key = `graphdiff:${repoId}:seen:${scope}`;
  const [baseline, setBaseline] = useState<Record<string, string> | null>(null);
  const current = useMemo(() => (files ? Object.fromEntries(files.map((f) => [f.path, sig(f)])) : null), [files]);

  const save = (b: Record<string, string>) => {
    setBaseline(b);
    try {
      localStorage.setItem(key, JSON.stringify(b));
    } catch {}
  };

  // Load this scope's baseline; a first visit starts with nothing new.
  useEffect(() => {
    setBaseline(null);
  }, [key]);
  useEffect(() => {
    if (baseline || !current) return;
    let stored: Record<string, string> | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {}
    if (stored) setBaseline(stored);
    else save(current);
  }, [baseline, current, key]);

  const { news, gone } = useMemo(() => {
    const news = new Map<string, NewsKind>();
    if (!baseline || !current) return { news, gone: 0 };
    for (const [path, s] of Object.entries(current)) {
      if (!(path in baseline)) news.set(path, "new");
      else if (baseline[path] !== s) news.set(path, "updated");
    }
    const gone = Object.keys(baseline).filter((p) => !(p in current)).length;
    return { news, gone };
  }, [baseline, current]);

  const ack = (paths?: string[]) => {
    if (!current || !baseline) return;
    if (!paths) return save({ ...current });
    const next = { ...baseline };
    let changed = false;
    for (const p of paths) {
      if (p in current && next[p] !== current[p]) {
        next[p] = current[p];
        changed = true;
      }
    }
    if (changed) save(next);
  };

  return { files: news, gone, ack };
}
