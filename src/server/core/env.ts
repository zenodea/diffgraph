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

/** How a command's stdout is read: Claude's JSON stream / JSON result, or plain text. */
export type OutputFormat = "claude-stream-json" | "claude-json" | "text";

export interface Config {
  port: number;
  /** Branch to compare against; auto-detected when null. */
  base: string | null;
  /** What answers questions. No command: the same kind of agent as the one in the pane. */
  ask: { command: string[] | null; format: OutputFormat };
  /** One-line folder summaries on the map; command works like `ask`. */
  summary: { enabled: boolean; command: string[] | null; format: OutputFormat };
}

const defaults: Config = {
  port: 4777,
  base: null,
  ask: { command: null, format: "text" },
  summary: { enabled: true, command: null, format: "text" },
};

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    return { ...defaults, ...raw, ask: { ...defaults.ask, ...raw.ask }, summary: { ...defaults.summary, ...raw.summary } };
  } catch {
    return defaults;
  }
}
