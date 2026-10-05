// Finding (or starting) the local server and registering a repo with it. Used by
// the browser opener and the terminal view alike.
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./server/core/env.ts";
import { run } from "./server/core/proc.ts";
import { serverFile, type ServerInfo } from "./server/server.ts";

export function readInfo(): ServerInfo | null {
  try {
    return JSON.parse(readFileSync(serverFile, "utf8"));
  } catch {
    return null;
  }
}

export async function healthy(info: ServerInfo | null): Promise<boolean> {
  if (!info) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureServer(): Promise<ServerInfo> {
  const existing = readInfo();
  if (await healthy(existing)) return existing!;

  const log = openSync(join(stateDir, "server.log"), "a");
  const child = spawn(process.execPath, [join(import.meta.dirname, "cli.ts"), "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = readInfo();
    if (info && info.pid === child.pid && (await healthy(info))) return info;
  }
  throw new Error(`server did not start; see ${join(stateDir, "server.log")}`);
}

export interface Connection {
  base: string;
  token: string;
  repo: { id: string; name: string; root: string; paneId: string | null; agent: string | null };
}

/** The server, with the repo containing `cwd` registered; null when `cwd` isn't in a git repo. */
export async function connect(cwd: string, paneId: string | null, agent: string | null): Promise<Connection | null> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (top.code !== 0) return null;
  const info = await ensureServer();
  const base = `http://127.0.0.1:${info.port}`;
  const res = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-graphdiff-token": info.token },
    body: JSON.stringify({ root: top.stdout.trim(), paneId, agent }),
  });
  if (!res.ok) throw new Error(`register failed: ${await res.text()}`);
  return { base, token: info.token, repo: await res.json() };
}
