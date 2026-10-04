import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Changes } from "../git/changes.ts";
import { parseDiff } from "../git/diff.ts";
import { stateDir } from "../core/env.ts";
import type { ChangedFile, RepoState } from "../git/git.ts";
import type { FileDiff } from "../git/fileDiff.ts";
import { HttpError } from "../core/http.ts";
import { run } from "../core/proc.ts";
import type { Repo } from "../core/repos.ts";

/**
 * A file counts as reviewed only while its content still matches what you marked,
 * so an agent touching it again puts it back in the queue on its own.
 */
export type ReviewStatus = "reviewed" | "changed" | null;

interface Mark {
  hash: string;
  at: number;
}

type Store = Record<string, Record<string, Mark>>;

const reviewsDir = join(stateDir, "reviews");
const snapshotsDir = join(stateDir, "snapshots");
mkdirSync(reviewsDir, { recursive: true });
mkdirSync(snapshotsDir, { recursive: true });
const MAX_SNAPSHOT = 1_000_000;

function load(repo: Repo): Store {
  try {
    return JSON.parse(readFileSync(join(reviewsDir, `${repo.id}.json`), "utf8"));
  } catch {
    return {};
  }
}

function save(repo: Repo, store: Store) {
  writeFileSync(join(reviewsDir, `${repo.id}.json`), JSON.stringify(store));
}

/** Reviews are kept per branch; a detached HEAD gets its own bucket. */
export function branchKey(state: RepoState): string {
  return state.branch ?? `detached:${state.head ?? "unborn"}`;
}

const hashCache = new Map<string, { key: string; hash: string }>();

/** Content hash of the working file ("deleted" if gone), cached by mtime+size. */
async function contentHash(repo: Repo, path: string): Promise<string> {
  const abs = join(repo.root, path);
  let key: string;
  try {
    const s = await stat(abs);
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    return "deleted";
  }
  const cached = hashCache.get(abs);
  if (cached?.key === key) return cached.hash;
  const hash = createHash("sha1").update(await readFile(abs)).digest("hex");
  hashCache.set(abs, { key, hash });
  return hash;
}

export interface ReviewedFile extends ChangedFile {
  review: ReviewStatus;
  reviewedAt: number | null;
}

export async function withReviews(repo: Repo, state: RepoState, files: ChangedFile[]): Promise<ReviewedFile[]> {
  const marks = load(repo)[branchKey(state)] ?? {};
  return Promise.all(
    files.map(async (f) => {
      const mark = marks[f.path];
      if (!mark) return { ...f, review: null, reviewedAt: null };
      const same = mark.hash === (await contentHash(repo, f.path));
      return { ...f, review: same ? "reviewed" : "changed", reviewedAt: mark.at };
    }),
  );
}

/** Marks (or unmarks) files reviewed. `mtime` is what the page rendered, to refuse marking unseen edits. */
export async function setReviewed(repo: Repo, state: RepoState, files: { path: string; mtime: number | null }[], reviewed: boolean) {
  const store = load(repo);
  const marks = (store[branchKey(state)] ??= {});

  for (const { path, mtime } of files) {
    if (!reviewed) {
      delete marks[path];
      continue;
    }
    // Don't mark content you haven't seen: the page sends the mtime it rendered.
    const now = await stat(join(repo.root, path)).then((s) => s.mtimeMs, () => null);
    if (now !== mtime) throw new HttpError(409, `${path} changed while you were looking. Have another look first.`);
    const hash = await contentHash(repo, path);
    marks[path] = { hash, at: Date.now() };
    await snapshot(repo, path, hash);
  }
  save(repo, store);
}

/** Keeps a copy of reviewed content (content-addressed) so we can show "what changed since your review". */
async function snapshot(repo: Repo, path: string, hash: string) {
  const file = join(snapshotsDir, hash);
  if (hash === "deleted" || existsSync(file)) return;
  const data = await readFile(join(repo.root, path));
  if (data.length <= MAX_SNAPSHOT) writeFileSync(file, data);
}

/** Diff from the content you last reviewed to the working file now. */
export async function sinceReview(repo: Repo, changes: Changes, path: string): Promise<FileDiff & { reviewedAt: number }> {
  const file = changes.files.find((f) => f.path === path);
  const mark = load(repo)[branchKey(changes)]?.[path];
  if (!file || !mark) throw new HttpError(404, "No earlier review of this file.");
  const before = mark.hash === "deleted" ? "/dev/null" : join(snapshotsDir, mark.hash);
  if (!existsSync(before)) throw new HttpError(404, "The reviewed version is too big to have been kept.");
  const after = file.status === "D" ? "/dev/null" : join(repo.root, path);
  const res = await run("git", ["diff", "--no-index", "--no-color", "-U3", "--", before, after]);
  return { file, from: "review", hunks: parseDiff(res.stdout), binary: /^Binary files/m.test(res.stdout), tooLarge: false, reviewedAt: mark.at };
}
