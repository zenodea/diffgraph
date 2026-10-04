import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_TREE } from "../shared.ts";
import { run } from "./proc.ts";

export { EMPTY_TREE };

// Stops git from refreshing .git/index as a side effect, which would wake our own watcher.
const env = { GIT_OPTIONAL_LOCKS: "0" };

export async function git(root: string, args: string[], okCodes = [0]): Promise<string> {
  const res = await run("git", ["-c", "core.quotepath=off", ...args], { cwd: root, env });
  if (!okCodes.includes(res.code)) throw new Error(`git ${args[0]} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

async function tryGit(root: string, args: string[]): Promise<string | null> {
  const res = await run("git", args, { cwd: root, env });
  return res.code === 0 ? res.stdout.trim() : null;
}

export type Scope = "branch" | "uncommitted" | "session";

export type Status = "A" | "M" | "D" | "R" | "C" | "T";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: Status;
  added: number;
  deleted: number;
  binary: boolean;
  untracked: boolean;
  /** Working-file mtime (ms); null when deleted. */
  mtime: number | null;
}

export interface RepoState {
  branch: string | null;
  head: string | null;
  /** The ref we compare the branch against, e.g. "main" or "origin/main". */
  base: string | null;
  mergeBase: string | null;
}

/**
 * Picks the base whose merge-base is closest to HEAD, so a stale local main and a
 * fresh origin/main both work. Returns nulls on an unborn branch.
 */
export async function repoState(root: string, configuredBase: string | null): Promise<RepoState> {
  const head = await tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const branch = await tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!head) return { branch, head: null, base: null, mergeBase: null };

  const originHead = await tryGit(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  const candidates = [
    configuredBase,
    originHead?.replace(/^origin\//, ""),
    originHead,
    "main", "origin/main", "master", "origin/master",
  ].filter((c, i, all): c is string => !!c && all.indexOf(c) === i && c !== branch);

  let best: { base: string; mergeBase: string; ahead: number } | null = null;
  for (const base of candidates) {
    if (!(await tryGit(root, ["rev-parse", "--verify", "-q", `${base}^{commit}`]))) continue;
    const mergeBase = await tryGit(root, ["merge-base", "HEAD", base]);
    if (!mergeBase) continue;
    const ahead = Number(await tryGit(root, ["rev-list", "--count", `${mergeBase}..HEAD`]));
    if (!best || ahead < best.ahead) best = { base, mergeBase, ahead };
    if (base === configuredBase) break;
  }
  return { branch, head, base: best?.base ?? null, mergeBase: best?.mergeBase ?? null };
}

/** The commit (or empty tree) a scope diffs the working tree against. */
export function scopeFrom(state: RepoState, scope: Scope, sessionStart?: string | null): string {
  if (!state.head) return EMPTY_TREE;
  if (scope === "uncommitted") return state.head;
  if (scope === "session" && sessionStart) return sessionStart;
  return state.mergeBase ?? state.head;
}

/** The last commit before `time`, i.e. what HEAD probably was when a session started. */
export async function commitBefore(root: string, time: Date): Promise<string | null> {
  const sha = await tryGit(root, ["rev-list", "-1", `--before=${Math.floor(time.getTime() / 1000)}`, "HEAD"]);
  return sha || null;
}

export async function changedFiles(root: string, from: string): Promise<ChangedFile[]> {
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(root, ["diff", "--name-status", "-z", "-M", from]),
    git(root, ["diff", "--numstat", "-z", "-M", from]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);

  const files = new Map<string, ChangedFile>();
  const ns = nameStatus.split("\0");
  for (let i = 0; i < ns.length - 1; ) {
    const code = ns[i++];
    const status = code[0] as Status;
    if (status === "R" || status === "C") {
      const oldPath = ns[i++];
      const path = ns[i++];
      files.set(path, base(path, status, oldPath));
    } else {
      const path = ns[i++];
      files.set(path, base(path, status === ("U" as string) ? "M" : status));
    }
  }

  // numstat -z: "a\td\tpath\0", or "a\td\t\0old\0new\0" for renames.
  const nums = numstat.split("\0");
  for (let i = 0; i < nums.length - 1; ) {
    const [a, d, p] = nums[i++].split("\t");
    const path = p === "" ? (i++, nums[i++]) : p;
    const f = files.get(path);
    if (!f) continue;
    f.binary = a === "-";
    f.added = f.binary ? 0 : Number(a);
    f.deleted = f.binary ? 0 : Number(d);
  }

  for (const path of untracked.split("\0").filter(Boolean)) {
    const f = base(path, "A");
    f.untracked = true;
    const { lines, binary } = await countLines(join(root, path));
    f.added = lines;
    f.binary = binary;
    files.set(path, f);
  }

  await Promise.all(
    [...files.values()].map(async (f) => {
      if (f.status === "D") return;
      try {
        f.mtime = (await stat(join(root, f.path))).mtimeMs;
      } catch {}
    }),
  );
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function base(path: string, status: Status, oldPath?: string): ChangedFile {
  return { path, ...(oldPath && { oldPath }), status, added: 0, deleted: 0, binary: false, untracked: false, mtime: null };
}

async function countLines(file: string): Promise<{ lines: number; binary: boolean }> {
  try {
    const fh = await open(file);
    try {
      const { size } = await fh.stat();
      if (size > 5_000_000) return { lines: 0, binary: true };
      const buf = await fh.readFile();
      if (buf.subarray(0, 8000).includes(0)) return { lines: 0, binary: true };
      let lines = 0;
      for (const b of buf) if (b === 10) lines++;
      if (buf.length && buf[buf.length - 1] !== 10) lines++;
      return { lines, binary: false };
    } finally {
      await fh.close();
    }
  } catch {
    return { lines: 0, binary: false };
  }
}

/** Every tracked and untracked (not ignored) path, for the whole-repo tree. */
export async function allFiles(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

/** Cheap fingerprint of the working tree and HEAD; changes whenever any diff could. */
export async function fingerprint(root: string): Promise<string> {
  const [head, status] = await Promise.all([
    tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const paths = status.split("\0").filter(Boolean).map((e) => e.slice(3));
  const mtimes = await Promise.all(paths.map((p) => stat(join(root, p)).then((s) => s.mtimeMs, () => 0)));
  return `${head}\n${status}\n${mtimes.join(",")}`;
}
