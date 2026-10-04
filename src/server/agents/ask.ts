// Questions asked on the diff. Each thread hangs off a file (and optionally a
// line range). "inline" runs a read-only side agent and streams its answer into
// the page; "agent" hands the question to the agent in the herdr pane.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Changes } from "../git/changes.ts";
import { loadConfig, stateDir, herdrBin } from "../core/env.ts";
import { diffFile } from "../git/fileDiff.ts";
import { HttpError } from "../core/http.ts";
import { broadcast } from "../core/live.ts";
import { run } from "../core/proc.ts";
import type { Repo } from "../core/repos.ts";
import { whyFor } from "./why.ts";

export interface Anchor {
  side: "new" | "old";
  start: number;
  end: number;
}

export interface Message {
  role: "you" | "answer" | "sent";
  text: string;
  at: number;
  status: "streaming" | "done" | "error";
  /** For "answer": who answered; for "sent": the agent it went to. */
  by?: string;
}

export interface Thread {
  id: string;
  path: string;
  anchor: Anchor | null;
  /** The selected code when the thread started, so it still reads right after edits. */
  code: string;
  createdAt: number;
  messages: Message[];
}

const dir = join(stateDir, "threads");
mkdirSync(dir, { recursive: true });
const threads = new Map<string, Thread[]>();
const jobs = new Map<string, ChildProcess>();

function list(repo: Repo): Thread[] {
  let t = threads.get(repo.id);
  if (!t) {
    try {
      t = JSON.parse(readFileSync(join(dir, `${repo.id}.json`), "utf8")) as Thread[];
      // Answers that were streaming when the server stopped never finished.
      for (const th of t) for (const m of th.messages) if (m.status === "streaming") (m.status = "error"), (m.text ||= "Interrupted.");
    } catch {
      t = [];
    }
    threads.set(repo.id, t);
  }
  return t;
}

let saveTimer: NodeJS.Timeout | null = null;
function save(repo: Repo) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeFileSync(join(dir, `${repo.id}.json`), JSON.stringify(list(repo)));
  }, 300);
}

function publish(repo: Repo, thread: Thread) {
  save(repo);
  broadcast(repo.id, "thread", thread);
}

export const getThreads = (repo: Repo) => list(repo);

export function deleteThread(repo: Repo, id: string) {
  jobs.get(id)?.kill();
  const t = list(repo);
  const i = t.findIndex((x) => x.id === id);
  if (i !== -1) t.splice(i, 1);
  save(repo);
  broadcast(repo.id, "thread-deleted", { id });
}

export interface AskInput {
  question: string;
  target: "inline" | "agent";
}

export async function startThread(repo: Repo, changes: Changes, input: AskInput & { path: string; anchor: Anchor | null; code: string }) {
  const thread: Thread = { id: randomUUID(), path: input.path, anchor: input.anchor, code: input.code.slice(0, 20_000), createdAt: Date.now(), messages: [] };
  list(repo).push(thread);
  await ask(repo, changes, thread, input);
  return thread;
}

export async function reply(repo: Repo, changes: Changes, id: string, input: AskInput) {
  const thread = list(repo).find((t) => t.id === id);
  if (!thread) throw new HttpError(404, "thread not found");
  if (jobs.has(id)) throw new HttpError(409, "Still answering the last question.");
  await ask(repo, changes, thread, input);
  return thread;
}

async function ask(repo: Repo, changes: Changes, thread: Thread, { question, target }: AskInput) {
  if (!question.trim()) throw new HttpError(400, "empty question");
  const history = thread.messages.slice();
  thread.messages.push({ role: "you", text: question.trim(), at: Date.now(), status: "done" });
  if (target === "agent") return sendToAgent(repo, thread, question.trim());
  const prompt = await buildPrompt(repo, changes, thread, history, question.trim());
  runSideAgent(repo, thread, prompt);
}

function where(thread: Thread): string {
  if (!thread.anchor) return thread.path;
  const { side, start, end } = thread.anchor;
  const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
  return `${thread.path} ${side === "old" ? `(removed ${range})` : range}`;
}

async function sendToAgent(repo: Repo, thread: Thread, question: string) {
  const msg: Message = { role: "sent", text: "", at: Date.now(), status: "streaming", by: repo.agent ?? "agent" };
  thread.messages.push(msg);
  publish(repo, thread);
  if (!repo.paneId) {
    Object.assign(msg, { status: "error", text: "graphdiff wasn't opened from a herdr pane, so there's no agent to send to." });
    return publish(repo, thread);
  }
  const text = `[graphdiff] About ${where(thread)}: ${question}`;
  const res = await run(herdrBin, ["agent", "prompt", repo.paneId, text]);
  if (res.code === 0) Object.assign(msg, { status: "done", text: "Sent. The answer will show up in its herdr pane." });
  else {
    const err = (() => {
      try {
        return JSON.parse(res.stdout || res.stderr).error?.message;
      } catch {
        return null;
      }
    })();
    Object.assign(msg, { status: "error", text: `Couldn't send: ${err ?? (res.stderr.trim() || "herdr refused")}` });
  }
  publish(repo, thread);
}

const MAX_DIFF_CHARS = 24_000;

async function buildPrompt(repo: Repo, changes: Changes, thread: Thread, history: Message[], question: string) {
  const file = changes.files.find((f) => f.path === thread.path);
  const diff = file ? await diffFile(repo, changes.from, file, false).catch(() => "") : "";
  const why = await whyFor(repo, changes.from, thread.path).catch(() => []);
  const parts = [
    `A developer is reviewing changes a coding agent made in the git repository at ${repo.root}.`,
    `They are looking at ${where(thread)}${file ? ` (status ${file.status})` : ""}.`,
  ];
  if (thread.code) parts.push(`The code they selected:\n\`\`\`\n${thread.code}\n\`\`\``);
  if (diff) parts.push(`The diff of this file:\n\`\`\`diff\n${diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n…(truncated)" : diff}\n\`\`\``);
  if (why.length) {
    const lines = why.slice(0, 3).map((w) => `- They asked the ${w.agent} agent: "${w.prompt.slice(0, 600)}"${w.reasons.length ? `\n  It said before editing: "${w.reasons[w.reasons.length - 1].slice(0, 600)}"` : ""}`);
    parts.push(`Context from the agent's session:\n${lines.join("\n")}`);
  }
  const earlier = history.filter((m) => m.role !== "sent" && m.status === "done");
  if (earlier.length) parts.push(`Earlier in this conversation:\n${earlier.map((m) => `${m.role === "you" ? "Developer" : "You"}: ${m.text}`).join("\n\n")}`);
  parts.push(`Their question: ${question}`);
  parts.push("Answer directly and briefly (a few short paragraphs at most, plain markdown). Read other files in the repo if you need to, but don't change anything.");
  return parts.join("\n\n");
}

const ASK_TIMEOUT_MS = 5 * 60_000;

function runSideAgent(repo: Repo, thread: Thread, prompt: string) {
  const { command, format } = loadConfig().ask;
  const msg: Message = { role: "answer", text: "", at: Date.now(), status: "streaming", by: command[0] };
  thread.messages.push(msg);
  publish(repo, thread);

  // Don't let a nested Claude Code think it's running inside the session that started us.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  let child: ChildProcess;
  try {
    child = spawn(command[0], command.slice(1), { cwd: repo.root, env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    Object.assign(msg, { status: "error", text: `Couldn't start ${command[0]}: ${e}` });
    return publish(repo, thread);
  }
  jobs.set(thread.id, child);
  const timer = setTimeout(() => child.kill(), ASK_TIMEOUT_MS);

  let throttle: NodeJS.Timeout | null = null;
  const update = () => {
    if (!throttle) throttle = setTimeout(() => ((throttle = null), publish(repo, thread)), 120);
  };
  let buf = "";
  let stderr = "";
  let result: string | null = null;
  child.stdout!.on("data", (chunk: Buffer) => {
    if (format === "text") {
      msg.text += chunk.toString("utf8");
      return update();
    }
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const delta = e.type === "stream_event" && e.event?.type === "content_block_delta" ? e.event.delta : null;
      if (delta?.type === "text_delta") {
        msg.text += delta.text;
        update();
      } else if (e.type === "stream_event" && e.event?.type === "message_start" && msg.text) {
        // A new assistant message after tool use: keep the answers apart.
        msg.text += "\n\n";
      } else if (e.type === "result") {
        result = typeof e.result === "string" ? e.result : null;
        if (e.is_error) msg.status = "error";
      }
    }
  });
  child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-4000)));
  child.on("error", (e) => {
    stderr += String(e);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (throttle) clearTimeout(throttle);
    jobs.delete(thread.id);
    if (result !== null) msg.text = result;
    if (msg.status !== "error") msg.status = code === 0 ? "done" : "error";
    if (msg.status === "error" && !msg.text.trim()) msg.text = stderr.trim().slice(-800) || `${command[0]} exited with ${code}`;
    publish(repo, thread);
  });
  child.stdin!.end(prompt);
}
