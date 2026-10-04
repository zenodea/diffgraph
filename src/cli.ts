// graphdiff entrypoint.
//   open   start the server if needed and open the focused pane's repo (herdr action)
//   serve  run the server in the foreground
//   stop   stop a running server
//   notify herdr event hook: tell you the shape of what an agent just changed
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./server/core/env.ts";
import { contextFromEnv, notify } from "./server/core/herdr.ts";
import { run } from "./server/core/proc.ts";
import { serverFile, type ServerInfo } from "./server/server.ts";

const command = process.argv[2] ?? "open";

function readInfo(): ServerInfo | null {
  try {
    return JSON.parse(readFileSync(serverFile, "utf8"));
  } catch {
    return null;
  }
}

async function healthy(info: ServerInfo | null): Promise<boolean> {
  if (!info) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<ServerInfo> {
  const existing = readInfo();
  if (await healthy(existing)) return existing!;

  const log = openSync(join(stateDir, "server.log"), "a");
  const child = spawn(process.execPath, [import.meta.filename, "serve"], {
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

async function open() {
  const ctx = contextFromEnv();
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
  if (top.code !== 0) {
    await notify("graphdiff", `${ctx.cwd} is not inside a git repo`);
    process.exit(1);
  }
  const root = top.stdout.trim();
  const info = await ensureServer();
  const base = `http://127.0.0.1:${info.port}`;
  const res = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-graphdiff-token": info.token },
    body: JSON.stringify({ root, paneId: ctx.paneId, agent: ctx.agent }),
  });
  if (!res.ok) throw new Error(`register failed: ${await res.text()}`);
  const repo = (await res.json()) as { id: string };
  const url = `${base}/r/${repo.id}?t=${info.token}`;
  console.log(url);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

async function stop() {
  const info = readInfo();
  if (!(await healthy(info))) return console.log("graphdiff server is not running");
  await fetch(`http://127.0.0.1:${info!.port}/api/shutdown`, {
    method: "POST",
    headers: { "x-graphdiff-token": info!.token },
  });
  console.log("stopped");
}

try {
  if (command === "serve") {
    const { startServer } = await import("./server/server.ts");
    await startServer();
  } else if (command === "open") await open();
  else if (command === "stop") await stop();
  else if (command === "notify") {
    // Runs on every agent status change: never make noise when something's off.
    const { notifyAgentDone } = await import("./server/notify.ts");
    await notifyAgentDone(process.env.HERDR_PLUGIN_EVENT_JSON).catch((e) => console.error(e));
  }
  else {
    console.error(`unknown command: ${command} (use open, serve or stop)`);
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  await notify("graphdiff failed", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
