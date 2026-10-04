import { commitBefore, git } from "./git.ts";
import { getAgent } from "./herdr.ts";
import type { Repo } from "./repos.ts";
import { findSessions, paneSession, readSession, toRepoPath, type AgentKind, type Session } from "./transcripts.ts";

export interface SessionInfo {
  agent: AgentKind;
  startedAt: string | null;
  prompts: number;
  file: string;
}

const PANE_CACHE_MS = 20_000;
const paneCache = new Map<string, { at: number; session: Session | null }>();

/** The transcript of the agent in the pane graphdiff was opened from, if we can find it. */
export async function currentSession(repo: Repo): Promise<Session | null> {
  const cached = paneCache.get(repo.id);
  if (cached && Date.now() - cached.at < PANE_CACHE_MS) return cached.session;
  const live = repo.paneId ? await getAgent(repo.paneId).catch(() => null) : null;
  const ref = await paneSession(repo.root, live?.agent ?? repo.agent, live?.sessionPath ?? null);
  const session = ref ? await readSession(ref.agent, ref.file) : null;
  paneCache.set(repo.id, { at: Date.now(), session });
  return session;
}

export function sessionInfo(s: Session): SessionInfo {
  return { agent: s.agent, startedAt: s.startedAt, prompts: s.turns.length, file: s.file };
}

/** Repo paths a session edited. */
export function editedPaths(repo: Repo, s: Session): Set<string> {
  const out = new Set<string>();
  for (const t of s.turns) for (const e of t.edits) {
    const p = toRepoPath(repo.root, s.cwd, e.path);
    if (p) out.add(p);
  }
  return out;
}

/** What HEAD most likely was when the session started (null: before the first commit). */
export async function sessionBase(repo: Repo, s: Session): Promise<string | null> {
  return s.startedAt ? commitBefore(repo.root, new Date(s.startedAt)) : null;
}

export interface WhyEntry {
  agent: AgentKind;
  /** The prompt that led to the edits. */
  prompt: string;
  at: string;
  lastEditAt: string;
  /** What the agent said before its edits, in order, deduplicated. */
  reasons: string[];
  edits: number;
  /** From the session running in the herdr pane right now. */
  current: boolean;
}

/** Every prompt (across this repo's recent sessions) that led to edits of `path`, newest first. */
export async function whyFor(repo: Repo, from: string, path: string): Promise<WhyEntry[]> {
  const since = await commitTime(repo, from);
  const refs = await findSessions(repo.root, since);
  const current = await currentSession(repo);
  const files = [...new Set([...(current ? [current.file] : []), ...refs.map((r) => r.file)])];
  const out: WhyEntry[] = [];
  for (const file of files) {
    const ref = refs.find((r) => r.file === file);
    const s = file === current?.file ? current : ref ? await readSession(ref.agent, ref.file) : null;
    if (!s) continue;
    for (const t of s.turns) {
      const edits = t.edits.filter((e) => toRepoPath(repo.root, s.cwd, e.path) === path);
      if (!edits.length) continue;
      out.push({
        agent: s.agent,
        prompt: t.prompt,
        at: t.at,
        lastEditAt: edits[edits.length - 1].at,
        reasons: [...new Set(edits.map((e) => e.reason).filter((r): r is string => !!r))],
        edits: edits.length,
        current: s.file === current?.file,
      });
    }
  }
  return out.sort((a, b) => b.lastEditAt.localeCompare(a.lastEditAt));
}

/** Commit time (ms) of a scope's base, minus a day of slack for sessions that started earlier. */
async function commitTime(repo: Repo, from: string): Promise<number> {
  try {
    const out = await git(repo.root, ["show", "-s", "--format=%ct", from]);
    return Number(out.trim()) * 1000 - 86_400_000;
  } catch {
    return 0;
  }
}
