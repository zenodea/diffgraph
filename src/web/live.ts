import { useEffect, useRef, useState } from "preact/hooks";
import type { Thread } from "../server/ask.ts";
import { repoId, token } from "./api.ts";

export interface Live {
  connected: boolean;
  /** "claude:working" etc., from herdr; null when the pane has no agent. */
  agent: string | null;
  /** A newer tab opened for this repo. */
  superseded: boolean;
  dismissSuperseded: () => void;
}

export interface LiveHandlers {
  /** Paths the watcher saw move (empty after a reconnect: refetch everything). */
  onChanges: (paths: string[]) => void;
  onThread: (thread: Thread) => void;
  onThreadDeleted: (id: string) => void;
}

/** Subscribes to the server's event stream. */
export function useLive(handlers: LiveHandlers): Live {
  const [connected, setConnected] = useState(false);
  const [agent, setAgent] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(false);
  const cb = useRef(handlers);
  cb.current = handlers;

  useEffect(() => {
    const es = new EventSource(`/api/repos/${repoId}/events?t=${token}`);
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);
    es.addEventListener("hello", (e) => {
      setConnected(true);
      setAgent(data(e).agent);
      // Anything could have changed while we were disconnected.
      cb.current.onChanges([]);
    });
    es.addEventListener("changes", (e) => cb.current.onChanges(data(e).paths));
    es.addEventListener("thread", (e) => cb.current.onThread(data(e)));
    es.addEventListener("thread-deleted", (e) => cb.current.onThreadDeleted(data(e).id));
    es.addEventListener("agent", (e) => setAgent(data(e).agent));
    // The map listens for these itself.
    es.addEventListener("summary", (e) => dispatchEvent(new CustomEvent("graphdiff:summary", { detail: data(e) })));
    es.addEventListener("superseded", () => setSuperseded(true));
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  return { connected, agent, superseded, dismissSuperseded: () => setSuperseded(false) };
}

/** Re-renders every `ms` so "x ago" labels and freshness dots stay current. */
export function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
