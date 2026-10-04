import { loadConfig } from "./env.ts";
import { allFiles, changedFiles, repoState, scopeFrom, type ChangedFile, type RepoState, type Scope } from "./git.ts";
import { HttpError, route } from "./http.ts";
import { repoOr404, type Repo } from "./repos.ts";

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

route("GET", "/api/repos/:id/changes", ({ params, url }) =>
  getChanges(repoOr404(params.id), parseScope(url.searchParams.get("scope"))),
);

route("GET", "/api/repos/:id/files", async ({ params }) => ({ paths: await allFiles(repoOr404(params.id).root) }));
