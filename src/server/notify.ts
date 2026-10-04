// Runs from a herdr event hook when an agent's status changes. When a turn has
// just finished, it posts a herdr notification with the shape of what changed,
// so you know where to look without opening anything.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editedPaths, currentSession, lastEditingTurn } from "./agents/why.ts";
import { herdrBin, loadConfig, stateDir } from "./core/env.ts";
import { notify } from "./core/herdr.ts";
import { run } from "./core/proc.ts";
import { repoId, type Repo } from "./core/repos.ts";
import { changedFiles, repoState, scopeFrom } from "./git/git.ts";

const sentFile = join(stateDir, "notified.json");

export async function notifyAgentDone(eventJson: string | undefined): Promise<void> {
  if (!loadConfig().notify) return;
  let data: { pane_id?: string; agent_status?: string; agent?: string } = {};
  try {
    const e = JSON.parse(eventJson ?? "{}");
    data = e.data ?? e;
  } catch {
    return;
  }
  if (data.agent_status !== "done" || !data.pane_id) return;

  const pane = await run(herdrBin, ["pane", "get", data.pane_id]);
  let cwd: string | undefined;
  try {
    const p = JSON.parse(pane.stdout).result?.pane;
    cwd = p?.foreground_cwd ?? p?.cwd;
  } catch {}
  if (!cwd) return;
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (top.code !== 0) return;
  const root = top.stdout.trim();

  // What the agent's latest prompt touched, if its transcript is around; otherwise
  // everything uncommitted.
  const repo: Repo = { id: repoId(root), root, name: root.split("/").pop()!, paneId: data.pane_id, agent: data.agent ?? null, openedAt: Date.now() };
  const state = await repoState(root, loadConfig().base);
  const uncommitted = await changedFiles(root, scopeFrom(state, "uncommitted"));
  const session = await currentSession(repo).catch(() => null);
  const turn = session && lastEditingTurn(session);
  const touched = turn ? editedPaths(repo, session!, [turn]) : null;
  const files = touched ? uncommitted.filter((f) => touched.has(f.path)) : uncommitted;
  if (!files.length) return;

  // Don't repeat the same news.
  const signature = files.map((f) => `${f.path}:${f.added}:${f.deleted}`).join("|");
  let sent: Record<string, string> = {};
  try {
    sent = JSON.parse(readFileSync(sentFile, "utf8"));
  } catch {}
  if (sent[data.pane_id] === signature) return;
  sent[data.pane_id] = signature;
  writeFileSync(sentFile, JSON.stringify(sent));

  const areas = new Map<string, number>();
  for (const f of files) {
    const parts = f.path.split("/");
    const area = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join("/") : "(root)";
    areas.set(area, (areas.get(area) ?? 0) + 1);
  }
  const top3 = [...areas].sort((a, b) => b[1] - a[1]);
  const shape = top3.slice(0, 3).map(([a, n]) => `${a} ${n}`).join(", ") + (top3.length > 3 ? `, +${top3.length - 3} more` : "");
  const who = data.agent ?? "agent";
  await notify(`${who} finished · ${repo.name}`, `Changed ${files.length} file${files.length === 1 ? "" : "s"}: ${shape}. prefix+g to look.`);
}
