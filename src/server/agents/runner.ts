// Picks the command that answers questions and writes summaries. By default it's
// the same kind of agent as the one in your herdr pane, run headless and
// read-only, so answers come from the tool (and account) you're already using.
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { loadConfig, type OutputFormat } from "../core/env.ts";
import { getAgent } from "../core/herdr.ts";
import type { Repo } from "../core/repos.ts";

export interface AgentCommand {
  command: string[];
  format: OutputFormat;
  /** Shown on answers ("claude", "codex", ...). */
  label: string;
}

type Purpose = "ask" | "summary";

// Each one: no session left behind (it would show up as a "why" session) and no
// way to change files.
const recipes: Record<string, Record<Purpose, AgentCommand>> = {
  claude: {
    ask: {
      label: "claude",
      format: "claude-stream-json",
      command: [
        "claude", "-p",
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--no-session-persistence",
        "--allowedTools", "Read,Grep,Glob",
        "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash",
      ],
    },
    // Small and fast, no tools: it only reads the diff it's handed.
    summary: { label: "claude", format: "claude-json", command: ["claude", "-p", "--model", "haiku", "--output-format", "json", "--no-session-persistence", "--tools", ""] },
  },
  codex: {
    ask: { label: "codex", format: "text", command: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-"] },
    summary: { label: "codex", format: "text", command: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-"] },
  },
  pi: {
    ask: { label: "pi", format: "text", command: ["pi", "-p", "--no-session", "--tools", "read,grep,find,ls"] },
    summary: { label: "pi", format: "text", command: ["pi", "-p", "--no-session", "--no-tools"] },
  },
};

const installedCache = new Map<string, boolean>();
function installed(bin: string): boolean {
  let hit = installedCache.get(bin);
  if (hit === undefined) {
    hit = (process.env.PATH ?? "").split(delimiter).some((dir) => {
      try {
        accessSync(join(dir, bin), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    installedCache.set(bin, hit);
  }
  return hit;
}

/** The configured command, or the pane agent's own headless mode (falling back to any we know). */
export async function agentCommand(purpose: Purpose, repo: Repo): Promise<AgentCommand | null> {
  const configured = loadConfig()[purpose];
  if (configured.command?.length) return { command: configured.command, format: configured.format, label: configured.command[0] };
  const live = repo.paneId ? await getAgent(repo.paneId).catch(() => null) : null;
  const kind = live?.agent ?? repo.agent;
  const order = [...new Set([kind, "claude", "codex", "pi"].filter((k): k is string => !!k && k in recipes))];
  const pick = order.find((k) => installed(recipes[k][purpose].command[0]));
  return pick ? recipes[pick][purpose] : null;
}
