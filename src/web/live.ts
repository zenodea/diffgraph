import { useEffect, useRef, useState } from "preact/hooks";
import { repoId, token } from "./api.ts";

export interface Live {
  connected: boolean;
  /** "claude:working" etc., from herdr; null when the pane has no agent. */
  agent: string | null;
  /** A newer tab opened for this repo. */
  superseded: boolean;
  dismissSuperseded: () => void;
}

/** Subscribes to the server's event stream; `onChanges` gets the paths that moved. */
export function useLive(onChanges: (paths: string[]) => void): Live {
  const [connected, setConnected] = useState(false);
  const [agent, setAgent] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(false);
  const cb = useRef(onChanges);
  cb.current = onChanges;

  useEffect(() => {
    const es = new EventSource(`/api/repos/${repoId}/events?t=${token}`);
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);
    es.addEventListener("hello", (e) => {
      setConnected(true);
      setAgent(data(e).agent);
      // Anything could have changed while we were disconnected.
      cb.current([]);
    });
    es.addEventListener("changes", (e) => cb.current(data(e).paths));
    es.addEventListener("agent", (e) => setAgent(data(e).agent));
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
