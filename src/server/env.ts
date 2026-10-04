import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// herdr hands plugin commands these dirs; fall back to the same locations when
// run by hand (npm run serve) so state is shared either way.
export const stateDir =
  process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".local/state/herdr/plugins/graphdiff");
export const configDir =
  process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(homedir(), ".config/herdr/plugins/config/graphdiff");
export const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";

mkdirSync(stateDir, { recursive: true });

export type AskFormat = "claude-stream-json" | "text";

export interface Config {
  port: number;
  /** Branch to compare against; auto-detected when null. */
  base: string | null;
  ask: { command: string[]; format: AskFormat };
}

const defaults: Config = {
  port: 4777,
  base: null,
  ask: {
    command: [
      "claude", "-p",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      // Q&A runs shouldn't leave transcripts behind (they'd show up as "why" sessions).
      "--no-session-persistence",
      "--allowedTools", "Read,Grep,Glob",
      "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash",
    ],
    format: "claude-stream-json",
  },
};

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    return { ...defaults, ...raw, ask: { ...defaults.ask, ...raw.ask } };
  } catch {
    return defaults;
  }
}
