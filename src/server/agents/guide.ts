// What each folder is *for* (not what changed in it): one line per folder, written
// by the pane's agent from the folder tree, a few file names and the README. Cached
// per repo; only folders that appear later trigger another call, since a codebase's
// shape changes far more slowly than its contents.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../core/env.ts";
import { broadcast } from "../core/live.ts";
import type { Repo } from "../core/repos.ts";
import { allFiles } from "../git/git.ts";
import { agentCommand } from "./runner.ts";

export interface Guide {
  /** Folder path → what it's for. */
  folders: Record<string, string>;
  /** Folders being described right now. */
  pending: string[];
}

const dir = join(stateDir, "guides");
mkdirSync(dir, { recursive: true });
const MAX_FOLDERS_PER_CALL = 120;
const FILES_PER_FOLDER = 8;

const stores = new Map<string, Record<string, string>>();
const pending = new Map<string, Set<string>>();

function store(repo: Repo): Record<string, string> {
  let s = stores.get(repo.id);
  if (!s) {
    try {
      s = JSON.parse(readFileSync(join(dir, `${repo.id}.json`), "utf8")) as Record<string, string>;
    } catch {
      s = {};
    }
    stores.set(repo.id, s);
  }
  return s;
}

export function getGuide(repo: Repo): Guide {
  return { folders: store(repo), pending: [...(pending.get(repo.id) ?? [])] };
}

/** Describes the folders in `wanted` that don't have a line yet (in the background, one call per batch). */
export function describeFolders(repo: Repo, wanted: string[]): Guide {
  const s = store(repo);
  const busy = (pending.get(repo.id) ?? new Set<string>());
  pending.set(repo.id, busy);
  const missing = [...new Set(wanted)].filter((f) => f && !(f in s) && !busy.has(f)).slice(0, MAX_FOLDERS_PER_CALL);
  if (missing.length) {
    missing.forEach((f) => busy.add(f));
    void run(repo, missing).finally(() => {
      missing.forEach((f) => busy.delete(f));
      broadcast(repo.id, "guide", getGuide(repo));
    });
  }
  return getGuide(repo);
}

async function run(repo: Repo, folders: string[]) {
  try {
    const prompt = await buildPrompt(repo, folders);
    const text = await ask(repo, prompt);
    const parsed = parseJson(text);
    if (!parsed) return console.error("guide: no JSON in the answer");
    const s = store(repo);
    for (const f of folders) {
      const line = parsed[f];
      if (typeof line === "string" && line.trim()) s[f] = line.trim().replace(/\.$/, "").slice(0, 140);
    }
    writeFileSync(join(dir, `${repo.id}.json`), JSON.stringify(s, null, 1));
  } catch (e) {
    console.error("guide failed:", e);
  }
}

async function buildPrompt(repo: Repo, folders: string[]): Promise<string> {
  const paths = await allFiles(repo.root);
  const inside = (folder: string) => {
    const direct = paths.filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
    const subs = new Set(paths.filter((p) => p.startsWith(folder + "/") && p.slice(folder.length + 1).includes("/")).map((p) => p.slice(folder.length + 1).split("/")[0]));
    return { files: direct.map((p) => p.slice(folder.length + 1)), subs: [...subs] };
  };
  const readme = await readFile(join(repo.root, "README.md"), "utf8").catch(() => "");
  const pkg = await readFile(join(repo.root, "package.json"), "utf8").then((t) => JSON.parse(t), () => null);
  const listing = folders
    .map((f) => {
      const { files, subs } = inside(f);
      const shown = files.slice(0, FILES_PER_FOLDER).join(", ") + (files.length > FILES_PER_FOLDER ? `, … (${files.length} files)` : "");
      return `${f}/\n  files: ${shown || "(none)"}${subs.length ? `\n  folders: ${subs.slice(0, 12).join(", ")}${subs.length > 12 ? ", …" : ""}` : ""}`;
    })
    .join("\n");
  return [
    `You're helping a developer learn the structure of the codebase "${repo.name}".`,
    pkg?.description ? `package.json says: ${pkg.description}` : "",
    readme ? `Start of its README:\n${readme.slice(0, 1500)}` : "",
    `For each folder below, write one short line (at most 12 words) saying what the folder is for: its role in the codebase, not a list of its files. Use plain words a newcomer would understand.`,
    `Folders:\n${listing}`,
    `Reply with only a JSON object mapping each folder path exactly as written (without the trailing slash) to its line. No markdown, no commentary.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function ask(repo: Repo, prompt: string): Promise<string | null> {
  const agent = await agentCommand("summary", repo);
  if (!agent) return null;
  const { command, format } = agent;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd: repo.root, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => resolve(null));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      if (format === "text") return resolve(out);
      try {
        const r = JSON.parse(out);
        resolve(r.is_error ? null : (r.result ?? null));
      } catch {
        resolve(out);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
