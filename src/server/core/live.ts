import { watch, type FSWatcher } from "node:fs";
import type { ServerResponse } from "node:http";
import { fingerprint } from "../git/git.ts";
import { getAgent } from "./herdr.ts";
import type { Repo } from "./repos.ts";

/** Paths whose churn never changes a diff (and can be huge). */
const IGNORED = /(^|\/)(node_modules|\.git\/(objects|logs|lfs)|\.DS_Store$)(\/|$)/;
const DEBOUNCE_MS = 250;
const MAX_WAIT_MS = 1500;
const AGENT_POLL_MS = 3000;

interface Client {
  res: ServerResponse;
  connectedAt: number;
}

/**
 * One per repo while a page is open: watches the working tree, pushes "changes"
 * when the diff could have moved, and mirrors the herdr agent's status.
 */
class Hub {
  repo: Repo;
  clients = new Set<Client>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private firstEventAt = 0;
  private pending = new Set<string>();
  private last = "";
  private agentTimer: NodeJS.Timeout | null = null;
  private agentStatus: string | null = null;

  constructor(repo: Repo) {
    this.repo = repo;
  }

  add(res: ServerResponse) {
    const client = { res, connectedAt: Date.now() };
    // A newer tab for the same repo: let the older ones know they can be closed.
    for (const c of this.clients) send(c.res, "superseded", {});
    this.clients.add(client);
    send(res, "hello", { pid: process.pid, agent: this.agentStatus });
    if (this.clients.size === 1) this.start();
    res.on("close", () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stop();
    });
  }

  private start() {
    fingerprint(this.repo.root).then((f) => (this.last = f), () => {});
    try {
      this.watcher = watch(this.repo.root, { recursive: true }, (_event, name) => {
        const path = typeof name === "string" ? name.split("\\").join("/") : "";
        if (path && IGNORED.test(path)) return;
        if (path && !path.startsWith(".git/")) this.pending.add(path);
        this.schedule();
      });
      this.watcher.on("error", (e) => console.error("watch error", e));
    } catch (e) {
      console.error(`can't watch ${this.repo.root}`, e);
    }
    this.pollAgent();
  }

  private stop() {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.agentTimer) clearTimeout(this.agentTimer);
    this.timer = this.agentTimer = null;
  }

  /** Debounced, but never waits longer than MAX_WAIT_MS while an agent writes nonstop. */
  private schedule() {
    const now = Date.now();
    if (!this.timer) this.firstEventAt = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.firstEventAt + MAX_WAIT_MS - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  private async flush() {
    this.timer = null;
    const paths = [...this.pending];
    this.pending.clear();
    let next: string;
    try {
      next = await fingerprint(this.repo.root);
    } catch {
      return;
    }
    if (next === this.last) return;
    this.last = next;
    for (const c of this.clients) send(c.res, "changes", { paths });
  }

  private async pollAgent() {
    if (this.repo.paneId) {
      const agent = await getAgent(this.repo.paneId).catch(() => null);
      const status = agent ? `${agent.agent}:${agent.status}` : null;
      if (status !== this.agentStatus) {
        this.agentStatus = status;
        for (const c of this.clients) send(c.res, "agent", { agent: status });
      }
    }
    if (this.clients.size) this.agentTimer = setTimeout(() => this.pollAgent(), AGENT_POLL_MS);
  }
}

function send(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const hubs = new Map<string, Hub>();

/** Sends an event to every page open on a repo. */
export function broadcast(repoId: string, event: string, data: unknown) {
  for (const c of hubs.get(repoId)?.clients ?? []) send(c.res, event, data);
}

/** Open event streams; the server stays up while there are any. */
export const liveConnections = new Set<ServerResponse>();

export function subscribe(repo: Repo, res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let hub = hubs.get(repo.id);
  if (!hub) hubs.set(repo.id, (hub = new Hub(repo)));
  hub.repo = repo;
  hub.add(res);
  liveConnections.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    liveConnections.delete(res);
  });
}
