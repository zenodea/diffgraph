import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stateDir } from "./env.ts";
import { HttpError } from "./http.ts";

export interface Repo {
  id: string;
  root: string;
  name: string;
  /** The herdr pane graphdiff was last opened from, and the agent in it then. */
  paneId: string | null;
  agent: string | null;
  openedAt: number;
}

const file = join(stateDir, "repos.json");
const repos = new Map<string, Repo>();

try {
  for (const r of JSON.parse(readFileSync(file, "utf8")) as Repo[]) repos.set(r.id, r);
} catch {}

export function repoId(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 10);
}

export function registerRepo(root: string, paneId: string | null, agent: string | null): Repo {
  const id = repoId(root);
  const repo: Repo = { id, root, name: basename(root), paneId, agent, openedAt: Date.now() };
  repos.set(id, repo);
  writeFileSync(file, JSON.stringify([...repos.values()], null, 2));
  return repo;
}

export function repoOr404(id: string): Repo {
  const repo = repos.get(id);
  if (!repo) throw new HttpError(404, "Unknown repo. Open graphdiff from herdr again (prefix+g).");
  return repo;
}

/** The latest registration of a repo (its pane can change when you open it from elsewhere). */
export function currentRepo(id: string): Repo | undefined {
  return repos.get(id);
}
