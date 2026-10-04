import { herdrBin } from "./env.ts";
import { run } from "./proc.ts";

/** The slice of HERDR_PLUGIN_CONTEXT_JSON we use. */
export interface PaneContext {
  paneId: string | null;
  cwd: string;
  agent: string | null;
}

export function contextFromEnv(): PaneContext {
  let ctx: Record<string, unknown> = {};
  try {
    ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {}
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    paneId: str(ctx.focused_pane_id) ?? process.env.HERDR_PANE_ID ?? null,
    cwd: str(ctx.focused_pane_cwd) ?? str(ctx.workspace_cwd) ?? process.cwd(),
    agent: str(ctx.focused_pane_agent),
  };
}

async function herdr(args: string[]): Promise<any | null> {
  const res = await run(herdrBin, args);
  if (res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout).result ?? null;
  } catch {
    return null;
  }
}

export interface AgentInfo {
  agent: string;
  status: string;
  sessionPath: string | null;
}

export async function getAgent(paneId: string): Promise<AgentInfo | null> {
  const res = await herdr(["agent", "get", paneId]);
  const a = res?.agent;
  if (!a?.agent) return null;
  const session = a.agent_session;
  return {
    agent: a.agent,
    status: a.agent_status ?? "unknown",
    sessionPath: session?.kind === "path" && typeof session.value === "string" ? session.value : null,
  };
}

export async function notify(title: string, body?: string): Promise<void> {
  await run(herdrBin, ["notification", "show", title, ...(body ? ["--body", body] : [])]);
}
