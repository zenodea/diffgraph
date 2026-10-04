import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion. Never throws on a non-zero exit; callers check `code`. */
interface RunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const res = await runBytes(cmd, args, opts);
  return { code: res.code, stdout: res.stdout.toString("utf8"), stderr: res.stderr };
}

/** Like run, but keeps stdout as bytes (for images). */
export function runBytes(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e) }));
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }),
    );
    child.stdin.end(opts.input ?? "");
  });
}
