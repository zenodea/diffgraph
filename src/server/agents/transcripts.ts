// Reads coding-agent session transcripts (Claude Code, Codex, pi) to answer
// "why did this file change?": the prompt you gave and what the agent said right
// before each edit. Files can be tens of MB, so parsing is streamed, cached, and
// incremental: a growing transcript is only read from where we left off.
import { createReadStream, realpathSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type AgentKind = "claude" | "codex" | "pi";

export interface Edit {
  /** As the agent wrote it: usually absolute, sometimes relative to its cwd. */
  path: string;
  tool: string;
  at: string;
  /** What the agent said just before making the edit. */
  reason: string | null;
}

export interface Turn {
  prompt: string;
  at: string;
  edits: Edit[];
}

export interface Session {
  agent: AgentKind;
  file: string;
  cwd: string | null;
  startedAt: string | null;
  turns: Turn[];
}

const MAX_TEXT = 1200;
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);

/** A line-by-line state machine; `feed` gets each parsed JSONL entry in order. */
abstract class Parser {
  cwd: string | null = null;
  startedAt: string | null = null;
  turns: Turn[] = [];
  protected lastText: string | null = null;
  protected pending = new Map<string, Omit<Edit, "path"> & { paths: string[] }>();

  abstract feed(e: any): void;

  protected turn(prompt: string, at: string) {
    this.turns.push({ prompt: clip(prompt.trim()), at, edits: [] });
    this.lastText = null;
  }

  protected current(at: string): Turn {
    if (!this.turns.length) this.turn("(session start)", at);
    return this.turns[this.turns.length - 1];
  }

  protected text(t: string) {
    if (t.trim()) this.lastText = clip(t.trim());
  }

  protected commit(paths: string[], tool: string, at: string, reason = this.lastText) {
    const turn = this.current(at);
    for (const p of paths) turn.edits.push({ path: p, tool, at, reason });
  }
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((c) => c?.type === "text" || c?.type === "input_text").map((c) => c.text ?? "").join("\n")
      : "";

class ClaudeParser extends Parser {
  feed(e: any) {
    if (e.isSidechain) return;
    if (!this.startedAt && e.timestamp) this.startedAt = e.timestamp;
    if (!this.cwd && e.cwd) this.cwd = e.cwd;
    const at = e.timestamp ?? this.startedAt ?? "";
    const content = e.message?.content;

    if (e.type === "user") {
      if (Array.isArray(content) && content.some((c) => c?.type === "tool_result")) {
        for (const c of content) {
          const p = c?.type === "tool_result" && this.pending.get(c.tool_use_id);
          if (!p) continue;
          this.pending.delete(c.tool_use_id);
          if (!c.is_error) this.commit(p.paths, p.tool, p.at, p.reason);
        }
        return;
      }
      if (e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) return;
      const kind = e.origin?.kind;
      const text = textOf(content);
      const human = kind === "human" || (!kind && typeof content === "string" && !content.startsWith("<"));
      if (human && text && !text.startsWith("[Request interrupted")) this.turn(text, at);
      return;
    }

    if (e.type === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === "text") this.text(c.text ?? "");
        else if (c?.type === "tool_use" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) {
          const path = c.input?.file_path ?? c.input?.notebook_path;
          if (typeof path === "string") this.pending.set(c.id, { paths: [path], tool: c.name, at, reason: this.lastText });
        }
      }
    }
  }
}

class CodexParser extends Parser {
  private seenUser = new Set<string>();

  feed(e: any) {
    const p = e.payload ?? {};
    const at = e.timestamp ?? "";
    if (e.type === "session_meta") {
      this.cwd ??= p.cwd ?? null;
      this.startedAt ??= p.timestamp ?? at;
      return;
    }
    if (e.type !== "event_msg") return;

    if (p.type === "item_completed" && p.item) {
      const item = p.item;
      if (item.type === "UserMessage") this.user(textOf(item.content), at, item.id);
      else if (item.type === "AgentMessage") this.text((item.content ?? []).map((c: any) => c.text ?? "").join("\n"));
      else if (item.type === "FileChange" && item.status === "completed") this.changes(item.changes, "apply_patch", at);
      return;
    }
    // Older Codex versions.
    if (p.type === "user_message") this.user(p.message ?? "", at);
    else if (p.type === "agent_message") this.text(p.message ?? "");
    else if (p.type === "patch_apply_end" && p.success !== false) this.changes(p.changes, "apply_patch", at);
  }

  private user(text: string, at: string, id?: string) {
    if (id) {
      if (this.seenUser.has(id)) return;
      this.seenUser.add(id);
    }
    if (text.trim()) this.turn(text, at);
  }

  private changes(changes: Record<string, { move_path?: string | null }> | undefined, tool: string, at: string) {
    if (!changes) return;
    const paths = Object.entries(changes).flatMap(([path, c]) => (c?.move_path ? [path, c.move_path] : [path]));
    this.commit(paths, tool, at);
  }
}

class PiParser extends Parser {
  private seen = new Set<string>();

  feed(e: any) {
    if (e.type === "session") {
      this.cwd ??= e.cwd ?? null;
      this.startedAt ??= e.timestamp ?? null;
      return;
    }
    if (e.type !== "message" || !e.message) return;
    // Forks copy entries with the same ids.
    if (e.id) {
      if (this.seen.has(e.id)) return;
      this.seen.add(e.id);
    }
    const m = e.message;
    const at = e.timestamp ?? "";
    if (m.role === "user") {
      const text = textOf(m.content);
      if (text.trim()) this.turn(text, at);
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === "text") this.text(c.text ?? "");
        else if (c?.type === "toolCall") {
          const a = c.arguments ?? {};
          const paths = c.name === "edit" || c.name === "write" ? [a.path] : c.name === "ast_grep_replace" && a.apply ? (a.paths ?? []) : [];
          const valid = paths.filter((p: unknown): p is string => typeof p === "string");
          if (valid.length) this.pending.set(c.id, { paths: valid, tool: c.name, at, reason: this.lastText });
        }
      }
    } else if (m.role === "toolResult") {
      const p = this.pending.get(m.toolCallId);
      if (!p) return;
      this.pending.delete(m.toolCallId);
      if (!m.isError) this.commit(p.paths, p.tool, p.at, p.reason);
    }
  }
}

const parsers: Record<AgentKind, new () => Parser> = { claude: ClaudeParser, codex: CodexParser, pi: PiParser };

interface CacheEntry {
  size: number;
  mtime: number;
  offset: number;
  parser: Parser;
}

const cache = new Map<string, CacheEntry>();

/** Parses a transcript, reusing earlier work when the file only grew. */
export async function readSession(agent: AgentKind, file: string): Promise<Session | null> {
  let s;
  try {
    s = await stat(file);
  } catch {
    return null;
  }
  let entry = cache.get(file);
  if (!entry || s.size < entry.offset || (s.size === entry.size && s.mtimeMs !== entry.mtime)) {
    entry = { size: 0, mtime: 0, offset: 0, parser: new parsers[agent]() };
    cache.set(file, entry);
  }
  if (s.size > entry.offset) entry.offset = await feedFrom(file, entry.offset, entry.parser);
  entry.size = s.size;
  entry.mtime = s.mtimeMs;
  const p = entry.parser;
  return { agent, file, cwd: p.cwd, startedAt: p.startedAt, turns: p.turns };
}

/** Feeds complete lines from `offset`; returns the offset after the last complete line. */
function feedFrom(file: string, offset: number, parser: Parser): Promise<number> {
  return new Promise((resolve, reject) => {
    let pos = offset;
    let rest = Buffer.alloc(0);
    const stream = createReadStream(file, { start: offset });
    stream.on("data", (chunk: Buffer | string) => {
      let buf = Buffer.concat([rest, chunk as Buffer]);
      let nl: number;
      while ((nl = buf.indexOf(10)) !== -1) {
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        pos += nl + 1;
        if (!line.trim()) continue;
        try {
          parser.feed(JSON.parse(line));
        } catch {}
      }
      rest = buf;
    });
    stream.on("end", () => resolve(pos));
    stream.on("error", reject);
  });
}

// ---- Finding sessions ------------------------------------------------------

export interface SessionRef {
  agent: AgentKind;
  file: string;
  mtime: number;
}

const home = homedir();
const claudeSlug = (cwd: string) => {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return slug.length > 200 ? null : slug; // long paths get a hash suffix we can't reproduce
};
const piSlug = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

function rootVariants(root: string): string[] {
  try {
    const real = realpathSync(root);
    return real === root ? [root] : [root, real];
  } catch {
    return [root];
  }
}

async function jsonlIn(dir: string, since: number): Promise<{ file: string; mtime: number }[]> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
    const files = await Promise.all(names.map(async (n) => ({ file: join(dir, n), mtime: (await stat(join(dir, n))).mtimeMs })));
    return files.filter((f) => f.mtime >= since);
  } catch {
    return [];
  }
}

async function firstLine(file: string): Promise<any> {
  const fh = await open(file);
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return JSON.parse(text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n")));
  } finally {
    await fh.close();
  }
}

async function codexSessions(roots: string[], since: number): Promise<SessionRef[]> {
  const out: SessionRef[] = [];
  const day = 86_400_000;
  // Folders are named by local date; walk each day from `since` to today (capped).
  for (let t = Math.max(since, Date.now() - 30 * day) - day; t <= Date.now() + day; t += day) {
    const d = new Date(t);
    const dir = join(home, ".codex/sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    for (const f of await jsonlIn(dir, since)) {
      try {
        const meta = (await firstLine(f.file))?.payload;
        if (meta?.source?.subagent) continue;
        if (roots.some((r) => meta?.cwd === r || meta?.cwd?.startsWith(r + "/"))) out.push({ agent: "codex", ...f });
      } catch {}
    }
  }
  return out;
}

/** Sessions of any agent that ran in this repo and were active since `since` (ms), newest first. */
export async function findSessions(root: string, since: number, limit = 8): Promise<SessionRef[]> {
  const roots = rootVariants(root);
  const found: SessionRef[] = [];
  for (const r of roots) {
    const slug = claudeSlug(r);
    if (slug) for (const f of await jsonlIn(join(home, ".claude/projects", slug), since)) found.push({ agent: "claude", ...f });
    for (const f of await jsonlIn(join(home, ".pi/agent/sessions", piSlug(r)), since)) found.push({ agent: "pi", ...f });
  }
  found.push(...(await codexSessions(roots, since)));
  const unique = [...new Map(found.map((f) => [f.file, f])).values()];
  return unique.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** The session the herdr pane's agent is most likely in right now. */
export async function paneSession(root: string, agent: string | null, sessionPath: string | null): Promise<SessionRef | null> {
  if (agent === "pi" && sessionPath) return { agent: "pi", file: sessionPath, mtime: Date.now() };
  if (agent !== "claude" && agent !== "codex" && agent !== "pi") return null;
  const all = await findSessions(root, 0, 50);
  return all.find((s) => s.agent === agent) ?? null;
}

/** Repo-relative form of a path an agent wrote, or null if it's outside the repo. */
export function toRepoPath(root: string, cwd: string | null, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(cwd ?? root, path);
  for (const r of rootVariants(root)) {
    const rel = relative(r, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
  }
  return null;
}
