import { useEffect, useState } from "preact/hooks";
import { repoId } from "./api.ts";

/** useState that survives reloads, per repo. */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const storageKey = `graphdiff:${repoId}:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(storageKey, JSON.stringify(v));
    } catch {}
  };
  return [value, set];
}

/** The selected file lives in the URL hash so reloads and back/forward keep your place. */
export function useHashPath(): [string | null, (p: string | null) => void] {
  const read = () => (location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null);
  const [path, setPath] = useState<string | null>(read);
  useEffect(() => {
    const onHash = () => setPath(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const set = (p: string | null) => {
    const hash = p ? `#${encodeURIComponent(p).replace(/%2F/g, "/")}` : " ";
    history.replaceState(null, "", hash === " " ? location.pathname + location.search : hash);
    setPath(p);
  };
  return [path, set];
}

/** Calls `handler` for keys pressed outside text inputs. */
export function useKeys(handler: (e: KeyboardEvent) => void, deps: unknown[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      handler(e);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, deps);
}
