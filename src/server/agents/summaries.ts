// One-line, plain-English summaries of what changed in each folder (and in the
// whole change), written by a small model and cached until the folder changes.
// Nothing is written until you ask for it: a summary costs a model call, so the
// page only requests the folders you pick, and an outdated one stays up (marked
// as such) until you ask again.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Changes } from "../git/changes.ts";
import { loadConfig, stateDir } from "../core/env.ts";
import { diffFile } from "../git/fileDiff.ts";
import { broadcast } from "../core/live.ts";
import type { Repo } from "../core/repos.ts";
import { agentCommand } from "./runner.ts";
import { whyFor } from "./why.ts";

export interface Summary {
  text: string;
  at: number;
  /** The folder changed since this was written; a fresh one is on its way. */
  stale: boolean;
}

interface Stored {
  key: string;
  text: string;
  at: number;
}

const dir = join(stateDir, "summaries");
mkdirSync(dir, { recursive: true });
const MAX_FOLDERS = 24;
const MAX_DIFF_CHARS = 18_000;
const CONCURRENCY = 2;

const stores = new Map<string, Record<string, Stored>>();
function store(repo: Repo): Record<string, Stored> {
  let s = stores.get(repo.id);
  if (!s) {
    try {
      s = JSON.parse(readFileSync(join(dir, `${repo.id}.json`), "utf8")) as Record<string, Stored>;
    } catch {
      s = {};
    }
    stores.set(repo.id, s);
  }
  return s;
}
const save = (repo: Repo) => writeFileSync(join(dir, `${repo.id}.json`), JSON.stringify(store(repo)));

const inFolder = (folder: string, path: string) => folder === "" || path.startsWith(folder + "/");

function keyFor(changes: Changes, folder: string): string {
  const sig = changes.files
    .filter((f) => inFolder(folder, f.path))
    .map((f) => `${f.path}:${f.status}:${f.added}:${f.deleted}`)
    .join("|");
  return createHash("sha1").update(`${changes.scope}\n${changes.from}\n${sig}`).digest("hex");
}

const queue: (() => Promise<void>)[] = [];
const queued = new Set<string>();
let running = 0;

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

/** Cached summaries for `folders` ("" = the whole change); those in `generate` get (re)written in the background. */
export function getSummaries(repo: Repo, changes: Changes, folders: string[], generate: string[] = []): Record<string, Summary | null> {
  const s = store(repo);
  const out: Record<string, Summary | null> = {};
  if (!loadConfig().summary.enabled) return out;
  for (const folder of folders.slice(0, MAX_FOLDERS)) {
    if (!changes.files.some((f) => inFolder(folder, f.path))) continue;
    const id = `${changes.scope}:${folder}`;
    const key = keyFor(changes, folder);
    const cached = s[id];
    const fresh = cached?.key === key;
    out[folder] = cached ? { text: cached.text, at: cached.at, stale: !fresh } : null;
    const due = generate.includes(folder) && !fresh;
    const jobId = `${repo.id}:${id}`;
    if (due && !queued.has(jobId)) {
      queued.add(jobId);
      queue.push(async () => {
        try {
          const text = await summarize(repo, changes, folder);
          if (text) {
            s[id] = { key, text, at: Date.now() };
            save(repo);
          }
          broadcast(repo.id, "summary", { scope: changes.scope, folder, summary: text ? { text, at: s[id].at, stale: false } : null });
        } catch (e) {
          console.error(`summary for ${folder || "(root)"} failed:`, e);
          broadcast(repo.id, "summary", { scope: changes.scope, folder, summary: null });
        } finally {
          queued.delete(jobId);
        }
      });
    }
  }
  pump();
  return out;
}

async function summarize(repo: Repo, changes: Changes, folder: string): Promise<string | null> {
  const files = changes.files.filter((f) => inFolder(folder, f.path));
  let diff = "";
  for (const f of [...files].sort((a, b) => b.added + b.deleted - (a.added + a.deleted))) {
    if (diff.length > MAX_DIFF_CHARS) break;
    if (f.binary) continue;
    diff += (await diffFile(repo, changes.from, f, false).catch(() => "")).slice(0, 6000) + "\n";
  }
  const why = folder === "" ? await whyFor(repo, changes.from, files[0]?.path ?? "").catch(() => []) : [];
  const list = files.map((f) => `${f.status} ${f.path} (+${f.added} -${f.deleted})`).join("\n");
  const where = folder === "" ? "this whole change" : `the folder ${folder}/`;
  const prompt = [
    `Summarize what changed in ${where} of a code repository, for a developer getting a feel for the change at a glance.`,
    `Files:\n${list}`,
    why.length ? `The developer had asked their coding agent: "${why[0].prompt.slice(0, 400)}"` : "",
    `Diff (may be cut short):\n${diff.slice(0, MAX_DIFF_CHARS)}`,
    `Reply with one plain sentence of at most ${folder === "" ? 22 : 14} words, saying what it does rather than listing files. No preamble, no quotes, no markdown.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const text = await runModel(repo, prompt);
  return text?.trim().replace(/^["']|["']$/g, "").split("\n")[0] || null;
}

async function runModel(repo: Repo, prompt: string): Promise<string | null> {
  const agent = await agentCommand("summary", repo);
  if (!agent) return null;
  const { command, format } = agent;
  const cwd = repo.root;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => resolve(null));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      if (format === "text") return resolve(out);
      try {
        const r = JSON.parse(out);
        resolve(r.is_error ? null : (r.result ?? null));
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(prompt);
  });
}
