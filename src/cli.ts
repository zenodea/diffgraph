// graphdiff entrypoint.
//   open   start the server if needed and open the focused pane's repo (herdr action)
//   serve  run the server in the foreground
//   stop   stop a running server
//   notify herdr event hook: tell you the shape of what an agent just changed
//   tui    the map in the terminal (run in a herdr pane by the "tui" action)
import { spawn } from "node:child_process";
import { connect, healthy, readInfo } from "./connect.ts";
import { contextFromEnv, notify } from "./server/core/herdr.ts";
import { run } from "./server/core/proc.ts";

const command = process.argv[2] ?? "open";

async function open() {
  const ctx = contextFromEnv();
  const conn = await connect(ctx.cwd, ctx.paneId, ctx.agent);
  if (!conn) {
    await notify("graphdiff", `${ctx.cwd} is not inside a git repo`);
    process.exit(1);
  }
  const { base, token, repo } = conn;
  const url = `${base}/r/${repo.id}?t=${token}`;
  console.log(url);
  if (await focusExistingTab(`${base}/r/${repo.id}`)) return;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

const chromeLike = ["Google Chrome", "Brave Browser", "Microsoft Edge"];

/** Running apps among `names`, checked without AppleScript (which would ask "where is X?" for apps that aren't installed). */
async function running(names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const n of names) if ((await run("pgrep", ["-x", n])).code === 0) out.push(n);
  return out;
}

/**
 * On macOS, brings an already-open graphdiff tab for this repo to the front
 * instead of opening another. Only asks browsers that are already running; if
 * macOS hasn't been allowed to let herdr control them, this quietly gives up.
 */
async function focusExistingTab(prefix: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const live = await running([...chromeLike, "Safari"]);
  if (!live.length) return false;
  const q = JSON.stringify(prefix);
  const chrome = (app: string) => `
  tell application "${app}"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if URL of t starts with ${q} then
          set active tab index of w to i
          set index of w to 1
          activate
          return "found"
        end if
      end repeat
    end repeat
  end tell`;
  const safari = `
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t starts with ${q} then
          set current tab of w to t
          set index of w to 1
          activate
          return "found"
        end if
      end repeat
    end repeat
  end tell`;
  const script = [...live.filter((a) => a !== "Safari").map(chrome), ...(live.includes("Safari") ? [safari] : []), 'return "none"'].join("\n");
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    // A permission prompt left unanswered shouldn't hold up opening the page.
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 4000);
    child.on("error", () => (clearTimeout(timer), resolve(false)));
    child.on("close", () => (clearTimeout(timer), resolve(out.trim() === "found")));
  });
}

/** herdr action: open the terminal view in an overlay over the focused pane, for its repo. */
async function openTuiPane() {
  const ctx = contextFromEnv();
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const args = ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID ?? "graphdiff", "--entrypoint", "tui", "--focus", "--cwd", ctx.cwd];
  if (ctx.paneId) args.push("--env", `GRAPHDIFF_PANE=${ctx.paneId}`);
  if (ctx.agent) args.push("--env", `GRAPHDIFF_AGENT=${ctx.agent}`);
  const res = await run(herdr, args);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "herdr couldn't open the pane");
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
  else if (command === "tui-open") await openTuiPane();
  else if (command === "tui") {
    const { runTui } = await import("./tui/app.ts");
    await runTui();
  }
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
