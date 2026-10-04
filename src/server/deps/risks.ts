// Things in a change worth a second look, shown on the map when you ask for them.
// All cheap, local heuristics: no model calls.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { changedShare } from "../../shared.ts";
import type { Changes } from "../git/changes.ts";
import { diffFile } from "../git/fileDiff.ts";
import type { Repo } from "../core/repos.ts";
import { importGraph } from "./deps.ts";

export interface Risks {
  /** Path → reasons. */
  files: Record<string, string[]>;
  /** About the change as a whole. */
  overall: string[];
}

const REWRITE_SHARE = 0.8;
const REWRITE_MIN_LINES = 20;
const LARGE_LINES = 400;
const TEST = /(^|\/)(tests?|__tests__|specs?)(\/|$)|[._-](test|spec)\.[a-z0-9]+$|_test\.go$/i;
const CODE = /\.(m|c)?[jt]sx?$|\.(py|go|rs|rb|java|kt|swift|cs|php|vue|svelte)$/;
const JS = /\.(m|c)?[jt]sx?$/;
const EXPORT = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

export async function risks(repo: Repo, changes: Changes): Promise<Risks> {
  const files: Record<string, string[]> = {};
  const add = (path: string, reason: string) => (files[path] ??= []).push(reason);

  for (const f of changes.files) {
    const size = f.added + f.deleted;
    if (f.status === "M" && !f.binary && (f.lines ?? 0) >= REWRITE_MIN_LINES && changedShare(f) >= REWRITE_SHARE) {
      add(f.path, `Mostly rewritten: about ${Math.round(changedShare(f) * 100)}% of the file changed`);
    }
    if (size >= LARGE_LINES) add(f.path, `Large change: +${f.added} −${f.deleted}`);
  }

  const graph = await importGraph(repo.root, changes.files.map((f) => f.path)).catch(() => null);
  if (graph) {
    const deleted = new Set(changes.files.filter((f) => f.status === "D").map((f) => f.path));
    for (const path of deleted) {
      const users = (graph.importers.get(path) ?? []).filter((u) => !deleted.has(u));
      if (users.length) add(path, `Deleted, but still imported by ${list(users)}`);
    }
    // Exports a JS/TS file lost, that other files still import by name.
    for (const f of changes.files) {
      if (f.status !== "M" || !JS.test(f.path) || deleted.has(f.path)) continue;
      const users = graph.importers.get(f.path) ?? [];
      if (!users.length) continue;
      const gone = await removedExports(repo, changes.from, f);
      for (const name of gone) {
        const still: string[] = [];
        for (const u of users) {
          const text = await readFile(join(repo.root, u), "utf8").catch(() => "");
          if (new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(text)) still.push(u);
        }
        if (still.length) add(f.path, `No longer exports ${name}, but ${list(still)} still import${still.length === 1 ? "s" : ""} it`);
      }
    }
  }

  const overall: string[] = [];
  const code = changes.files.filter((f) => CODE.test(f.path) && !TEST.test(f.path));
  if (code.length && !changes.files.some((f) => TEST.test(f.path))) {
    overall.push(`${code.length} code file${code.length === 1 ? "" : "s"} changed, but no tests did`);
  }
  return { files, overall };
}

async function removedExports(repo: Repo, from: string, f: Changes["files"][number]): Promise<string[]> {
  const diff = await diffFile(repo, from, f, false).catch(() => "");
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = EXPORT.exec(line.slice(1));
    if (!m) continue;
    if (line[0] === "-") removed.add(m[1]);
    else if (line[0] === "+") added.add(m[1]);
  }
  const now = await readFile(join(repo.root, f.path), "utf8").catch(() => "");
  return [...removed].filter((n) => !added.has(n) && !new RegExp(`export[^\\n]*\\b${n}\\b`).test(now));
}

const list = (paths: string[]) => (paths.length <= 2 ? paths.join(" and ") : `${paths.slice(0, 2).join(", ")} and ${paths.length - 2} more`);
