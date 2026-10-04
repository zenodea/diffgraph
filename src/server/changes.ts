import { EMPTY_TREE } from "../shared.ts";
import { loadConfig } from "./env.ts";
import { changedFiles, repoState, scopeFrom, type ChangedFile, type RepoState, type Scope } from "./git.ts";
import { HttpError } from "./http.ts";
import type { Repo } from "./repos.ts";
import { currentSession, editedPaths, sessionBase, sessionInfo, type SessionInfo } from "./why.ts";

export interface Changes extends RepoState {
  scope: Scope;
  from: string;
  files: ChangedFile[];
  /** The pane agent's session, when its transcript was found (enables the Session scope). */
  session: SessionInfo | null;
}

export function parseScope(value: string | null): Scope {
  if (value === null || value === "branch") return "branch";
  if (value === "uncommitted" || value === "session") return value;
  throw new HttpError(400, `unknown scope: ${value}`);
}

export async function getChanges(repo: Repo, scope: Scope): Promise<Changes> {
  const [state, session] = await Promise.all([repoState(repo.root, loadConfig().base), currentSession(repo)]);
  const info = session && sessionInfo(session);
  if (scope !== "session") {
    const from = scopeFrom(state, scope);
    return { ...state, scope, from, files: await changedFiles(repo.root, from), session: info };
  }
  if (!session) throw new HttpError(404, "No transcript found for this pane's agent, so there's no session to show.");
  // Diff from where HEAD was when the session started, limited to files the agent edited.
  const from = (await sessionBase(repo, session)) ?? EMPTY_TREE;
  const edited = editedPaths(repo, session);
  const files = (await changedFiles(repo.root, from)).filter((f) => edited.has(f.path) || (f.oldPath && edited.has(f.oldPath)));
  return { ...state, scope, from, files, session: info };
}
