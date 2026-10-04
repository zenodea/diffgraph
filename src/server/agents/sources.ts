// "Who changed what" for colouring the map: either the prompts of the pane's
// session, or the agent sessions that worked in this repo.
import { git } from "../git/git.ts";
import type { Changes } from "../git/changes.ts";
import { herdrBin } from "../core/env.ts";
import { run } from "../core/proc.ts";
import type { Repo } from "../core/repos.ts";
import { findSessions, readSession, type Session } from "./transcripts.ts";
import { currentSession, editedPaths } from "./why.ts";

export interface Source {
  id: string;
  label: string;
  /** Second line: when, which agent. */
  detail: string;
  at: string;
  /** Changed files (in this scope) it touched. */
  files: string[];
}

const MAX_SOURCES = 8;

export async function sources(repo: Repo, changes: Changes, by: "prompt" | "agent"): Promise<Source[]> {
  const changed = new Set(changes.files.map((f) => f.path));
  const inScope = (paths: Set<string>) => [...paths].filter((p) => changed.has(p));
  return by === "prompt" ? byPrompt(repo, inScope) : byAgent(repo, changes, inScope);
}

async function byPrompt(repo: Repo, inScope: (p: Set<string>) => string[]): Promise<Source[]> {
  const s = await currentSession(repo);
  if (!s) return [];
  const out: Source[] = [];
  s.turns.forEach((t, i) => {
    const files = inScope(editedPaths(repo, s, [t]));
    if (files.length) out.push({ id: `t${i}`, label: t.prompt.slice(0, 160), detail: `${s.agent} · prompt ${i + 1}`, at: t.at, files });
  });
  return out.slice(-MAX_SOURCES).reverse();
}

async function byAgent(repo: Repo, changes: Changes, inScope: (p: Set<string>) => string[]): Promise<Source[]> {
  const since = await commitTime(repo, changes.from);
  const refs = await findSessions(repo.root, since, MAX_SOURCES * 2);
  const current = await currentSession(repo);
  const panes = await liveAgents(repo.root);
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const ref of [...(current ? [{ agent: current.agent, file: current.file }] : []), ...refs]) {
    if (seen.has(ref.file)) continue;
    seen.add(ref.file);
    const s: Session | null = ref.file === current?.file ? current : await readSession(ref.agent, ref.file);
    if (!s) continue;
    const files = inScope(editedPaths(repo, s));
    if (!files.length) continue;
    // Name it after its herdr pane when we can tell which one it is.
    const pane = panes.find((p) => p.sessionPath === s.file) ?? (s.file === current?.file ? panes.find((p) => p.paneId === repo.paneId) : undefined);
    const last = [...s.turns].reverse().find((t) => t.edits.length);
    out.push({
      id: s.file,
      label: pane ? `${pane.name} (${pane.paneId})` : `${s.agent} session`,
      detail: `${s.agent}${s.startedAt ? ` · started ${s.startedAt.slice(0, 16).replace("T", " ")}` : ""}${pane ? "" : " · no open pane"}`,
      at: last?.at ?? s.startedAt ?? "",
      files,
    });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

interface LiveAgent {
  paneId: string;
  name: string;
  sessionPath: string | null;
}

/** herdr agents whose cwd is inside this repo. */
async function liveAgents(root: string): Promise<LiveAgent[]> {
  const res = await run(herdrBin, ["agent", "list"]);
  try {
    const agents = JSON.parse(res.stdout).result?.agents ?? [];
    return agents
      .filter((a: any) => typeof a.cwd === "string" && (a.cwd === root || a.cwd.startsWith(root + "/")))
      .map((a: any) => ({
        paneId: a.pane_id,
        name: a.name ?? a.agent,
        sessionPath: a.agent_session?.kind === "path" ? a.agent_session.value : null,
      }));
  } catch {
    return [];
  }
}

async function commitTime(repo: Repo, from: string): Promise<number> {
  try {
    return Number((await git(repo.root, ["show", "-s", "--format=%ct", from])).trim()) * 1000 - 86_400_000;
  } catch {
    return 0;
  }
}
