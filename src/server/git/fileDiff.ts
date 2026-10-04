import { readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import type { Changes } from "./changes.ts";
import { parseDiff, type Hunk } from "./diff.ts";
import { git, type ChangedFile } from "./git.ts";
import { HttpError } from "../core/http.ts";
import type { Repo } from "../core/repos.ts";
import { run, runBytes } from "../core/proc.ts";

const MAX_DIFF_BYTES = 4_000_000;

export interface FileDiff {
  file: ChangedFile;
  from: string;
  hunks: Hunk[];
  binary: boolean;
  tooLarge: boolean;
}

/** Unified diff of one file from `from` to the working tree. `full` gives the whole file as context. */
export async function diffFile(repo: Repo, from: string, file: ChangedFile, full: boolean): Promise<string> {
  const context = full ? "-U100000000" : "-U3";
  if (file.untracked) {
    const res = await run("git", ["diff", "--no-index", "--no-color", context, "--", "/dev/null", file.path], { cwd: repo.root });
    return res.stdout;
  }
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  return git(repo.root, ["diff", "--no-color", "-M", context, from, "--", ...paths]);
}

const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
};

/** Sends image bytes from the working tree, or from `rev` when given (for before/after previews). */
export async function sendImage(repo: Repo, path: string, rev: string | null, res: ServerResponse) {
  const type = imageTypes[extname(path).toLowerCase()];
  const abs = resolve(repo.root, path);
  if (!type || relative(repo.root, abs).startsWith("..")) throw new HttpError(400, "not an image in this repo");
  let data: Buffer;
  if (rev) {
    if (!/^[0-9a-f]{40}$/.test(rev)) throw new HttpError(400, "bad rev");
    const out = await runBytes("git", ["show", `${rev}:${path}`], { cwd: repo.root });
    if (out.code !== 0) throw new HttpError(404, "not in that revision");
    data = out.stdout;
  } else {
    data = await readFile(join(repo.root, path)).catch(() => {
      throw new HttpError(404, "file not found");
    });
  }
  // SVGs are untrusted repo content: never let them run as a document.
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" });
  res.end(data);
}

/** The diff of one changed file in a scope, ready for the page. */
export async function fileDiff(repo: Repo, changes: Changes, path: string, full: boolean): Promise<FileDiff> {
  const file = changes.files.find((f) => f.path === path);
  if (!file) throw new HttpError(404, "That file has no changes in this scope any more.");
  const result: FileDiff = { file, from: changes.from, hunks: [], binary: file.binary, tooLarge: false };
  if (file.binary) return result;
  const text = await diffFile(repo, changes.from, file, full);
  if (text.length > MAX_DIFF_BYTES) return { ...result, tooLarge: true };
  return { ...result, hunks: parseDiff(text) };
}

