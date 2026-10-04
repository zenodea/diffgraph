import { loadConfig } from "./env.ts";
import { changedFiles, repoState, scopeFrom, type ChangedFile, type RepoState, type Scope } from "./git.ts";
import { HttpError } from "./http.ts";
import type { Repo } from "./repos.ts";

export interface Changes extends RepoState {
  scope: Scope;
  from: string;
  files: ChangedFile[];
}

export function parseScope(value: string | null): Scope {
  if (value === null || value === "branch") return "branch";
  if (value === "uncommitted" || value === "session") return value;
  throw new HttpError(400, `unknown scope: ${value}`);
}

export async function getChanges(repo: Repo, scope: Scope): Promise<Changes> {
  const state = await repoState(repo.root, loadConfig().base);
  const from = scopeFrom(state, scope);
  const files = await changedFiles(repo.root, from);
  return { ...state, scope, from, files };
}
