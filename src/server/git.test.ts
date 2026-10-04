import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_TREE, changedFiles, repoState, scopeFrom } from "./git.ts";

let dir: string;
const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "graphdiff-git-"));
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("git", () => {
  it("handles an unborn branch", async () => {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    const state = await repoState(dir, null);
    expect(state.head).toBeNull();
    const files = await changedFiles(dir, scopeFrom(state, "branch"));
    expect(scopeFrom(state, "branch")).toBe(EMPTY_TREE);
    expect(files).toMatchObject([{ path: "a.txt", status: "A", added: 2, untracked: true }]);
  });

  it("separates branch and uncommitted scopes, with renames and deletes", async () => {
    writeFileSync(join(dir, "gone.txt"), "bye\n");
    writeFileSync(join(dir, "old.txt"), "same\ncontent\nhere\n");
    sh("add", "-A");
    sh("commit", "-qm", "init");
    sh("checkout", "-qb", "feature");
    sh("mv", "old.txt", "new.txt");
    sh("rm", "-q", "gone.txt");
    sh("commit", "-qm", "work");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");

    const state = await repoState(dir, null);
    expect(state).toMatchObject({ branch: "feature", base: "main" });

    const branch = await changedFiles(dir, scopeFrom(state, "branch"));
    expect(branch.map((f) => [f.status, f.path, f.oldPath])).toEqual([
      ["M", "a.txt", undefined],
      ["D", "gone.txt", undefined],
      ["R", "new.txt", "old.txt"],
    ]);
    const uncommitted = await changedFiles(dir, scopeFrom(state, "uncommitted"));
    expect(uncommitted).toMatchObject([{ path: "a.txt", status: "M", added: 1, deleted: 0 }]);
  });
});
