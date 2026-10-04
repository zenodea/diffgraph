import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readSession, toRepoPath } from "./transcripts.ts";

const dir = mkdtempSync(join(tmpdir(), "graphdiff-tx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const jsonl = (name: string, lines: unknown[]) => {
  const file = join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
};

describe("claude transcripts", () => {
  const t = "2026-10-04T10:00:00.000Z";
  const file = jsonl("claude.jsonl", [
    { type: "permission-mode" },
    { type: "user", timestamp: t, cwd: "/repo", origin: { kind: "human" }, message: { role: "user", content: "add a mul helper" } },
    { type: "user", timestamp: t, isMeta: true, message: { role: "user", content: "<local-command-caveat>" } },
    { type: "assistant", timestamp: t, message: { content: [{ type: "text", text: "I'll add mul to math.ts." }] } },
    { type: "assistant", timestamp: t, message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/math.ts" } }] } },
    { type: "assistant", timestamp: t, message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "/repo/src/bad.ts" } }] } },
    { type: "user", timestamp: t, message: { content: [{ type: "tool_result", tool_use_id: "t1" }, { type: "tool_result", tool_use_id: "t2", is_error: true }] } },
    { type: "user", timestamp: t, message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
    { type: "assistant", timestamp: t, isSidechain: true, message: { content: [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/repo/x" } }] } },
  ]);

  it("keeps human prompts and successful edits with the reason before them", async () => {
    const s = (await readSession("claude", file))!;
    expect(s.cwd).toBe("/repo");
    expect(s.startedAt).toBe(t);
    expect(s.turns).toEqual([{ prompt: "add a mul helper", at: t, edits: [{ path: "/repo/src/math.ts", tool: "Edit", at: t, reason: "I'll add mul to math.ts." }] }]);
  });

  it("reads only what was appended", async () => {
    appendFileSync(file, JSON.stringify({ type: "user", timestamp: t, origin: { kind: "human" }, message: { content: "now tests" } }) + "\n");
    const s = (await readSession("claude", file))!;
    expect(s.turns.map((x) => x.prompt)).toEqual(["add a mul helper", "now tests"]);
  });
});

describe("codex transcripts", () => {
  it("reads prompts, agent messages and file changes", async () => {
    const t = "2026-10-04T10:00:00.000Z";
    const file = jsonl("codex.jsonl", [
      { timestamp: t, type: "session_meta", payload: { cwd: "/repo", timestamp: t, source: "cli" } },
      { timestamp: t, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "rename it" }] } } },
      { timestamp: t, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "rename it" }] } } },
      { timestamp: t, type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "Renaming a.ts." }] } } },
      { timestamp: t, type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", status: "completed", changes: { "/repo/a.ts": { type: "update", move_path: "/repo/b.ts" } } } } },
    ]);
    const s = (await readSession("codex", file))!;
    expect(s.cwd).toBe("/repo");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].edits.map((e) => [e.path, e.reason])).toEqual([
      ["/repo/a.ts", "Renaming a.ts."],
      ["/repo/b.ts", "Renaming a.ts."],
    ]);
  });
});

describe("pi transcripts", () => {
  it("reads tool calls, skips failed ones and forked duplicates", async () => {
    const t = "2026-10-04T10:00:00.000Z";
    const user = { type: "message", id: "1", timestamp: t, message: { role: "user", content: [{ type: "text", text: "fix types" }] } };
    const file = jsonl("pi.jsonl", [
      { type: "session", cwd: "/repo", timestamp: t },
      user,
      user,
      { type: "message", id: "2", timestamp: t, message: { role: "assistant", content: [{ type: "text", text: "Fixing." }, { type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/types.ts" } }, { type: "toolCall", id: "c2", name: "write", arguments: { path: "/repo/x.ts" } }] } },
      { type: "message", id: "3", timestamp: t, message: { role: "toolResult", toolCallId: "c1", isError: false } },
      { type: "message", id: "4", timestamp: t, message: { role: "toolResult", toolCallId: "c2", isError: true } },
    ]);
    const s = (await readSession("pi", file))!;
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].edits.map((e) => e.path)).toEqual(["src/types.ts"]);
    expect(toRepoPath("/repo", s.cwd, "src/types.ts")).toBe("src/types.ts");
    expect(toRepoPath("/repo", s.cwd, "/elsewhere/x")).toBeNull();
  });
});
