import { useEffect, useRef, useState } from "preact/hooks";
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
export const readHashPath = () => (location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null);

export function useHashPath(): [string | null, (p: string | null) => void] {
  const [path, setPath] = useState<string | null>(readHashPath);
  useEffect(() => {
    const onHash = () => setPath(readHashPath());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const set = (p: string | null) => {
    history.replaceState(null, "", p ? `#${encodeURIComponent(p).replace(/%2F/g, "/")}` : location.pathname + location.search);
    setPath(p);
  };
  return [path, set];
}

/** Calls the latest `handler` for keys pressed outside text inputs. */
export function useKeys(handler: (e: KeyboardEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      ref.current(e);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}
