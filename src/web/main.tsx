import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Changes } from "../server/changes.ts";
import type { ChangedFile, Scope } from "../server/git.ts";
import type { FileDiff } from "../server/fileDiff.ts";
import { api, repoId, type Repo } from "./api.ts";
import { DiffView, type ViewMode } from "./DiffView.tsx";
import { readHashPath, useHashPath, useKeys, usePersisted } from "./hooks.ts";
import { DiffStat, StatusBadge, Tree } from "./Tree.tsx";
import { buildTree, visibleOrder } from "./tree.ts";
import "./styles.css";

const scopes: { id: Scope; label: string; hint: (c: Changes) => string }[] = [
  {
    id: "branch",
    label: "Branch",
    hint: (c) => (c.base ? `Everything since ${c.branch ?? "HEAD"} left ${c.base}, plus uncommitted work` : "No base branch found: showing uncommitted work"),
  },
  { id: "uncommitted", label: "Uncommitted", hint: () => "Only what isn't committed yet (staged, unstaged, new files)" },
];

function App() {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = usePersisted<Scope>("scope", "branch");
  const [changes, setChanges] = useState<Changes | null>(null);
  const [showAll, setShowAll] = usePersisted("showAll", false);
  const [allPaths, setAllPaths] = useState<string[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useHashPath();
  const [mode, setMode] = usePersisted<ViewMode>("mode", "unified");

  useEffect(() => {
    api<Repo>(`/api/repos/${repoId}`).then(setRepo, (e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!repo) return;
    api<Changes>(`/api/repos/${repoId}/changes?scope=${scope}`).then(setChanges, (e) => setError(e.message));
  }, [repo, scope]);

  useEffect(() => {
    if (showAll && !allPaths) api<{ paths: string[] }>(`/api/repos/${repoId}/files`).then((r) => setAllPaths(r.paths));
  }, [showAll]);

  const files = changes?.files ?? [];
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const tree = useMemo(() => {
    const paths = showAll && allPaths ? [...new Set([...allPaths, ...byPath.keys()])] : [...byPath.keys()];
    return buildTree(paths, byPath);
  }, [byPath, showAll, allPaths]);

  // In whole-repo mode, folders with nothing changed start collapsed.
  useEffect(() => {
    if (!showAll || !allPaths) return setCollapsed(new Set());
    const quiet = new Set<string>();
    const walk = (n: typeof tree) => {
      for (const c of n.children) if (c.dir) (c.changed.length ? walk(c) : quiet.add(c.path));
    };
    walk(tree);
    setCollapsed(quiet);
  }, [showAll, allPaths]);

  const order = useMemo(() => visibleOrder(tree, collapsed), [tree, collapsed]);
  const current = selected ? byPath.get(selected) ?? null : null;

  // Land on the first file instead of an empty pane.
  useEffect(() => {
    if (changes && !current && files.length) setSelected(order[0]?.path ?? null);
  }, [changes]);

  useKeys((e) => {
      // The hash updates synchronously, so fast repeats don't act on a stale selection.
      const i = order.findIndex((f) => f.path === readHashPath());
      if (e.key === "j") order[i + 1] && setSelected(order[i + 1].path);
      else if (e.key === "k") order[i - 1] && setSelected(order[i - 1].path);
      else if (e.key in modeKeys) setMode(modeKeys[e.key]);
      else return;
      e.preventDefault();
  });

  useEffect(() => {
    document.querySelector(".row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (error) return <Notice title="Can't open this repo" body={error} />;
  if (!repo || !changes) return <Notice title="Loading…" />;
  document.title = `${repo.name} · graphdiff`;

  const totals = files.reduce((t, f) => ({ added: t.added + f.added, deleted: t.deleted + f.deleted, binary: false }), { added: 0, deleted: 0, binary: false });
  const toggle = (path: string) => {
    const next = new Set(collapsed);
    next.has(path) ? next.delete(path) : next.add(path);
    setCollapsed(next);
  };

  return (
    <div class="app">
      <header class="topbar">
        <div class="repo">
          <span class="repo-name">{repo.name}</span>
          {changes.branch && (
            <span class="branch" title={changes.from}>
              {changes.branch}
              {scope === "branch" && changes.base && <span class="muted"> → {changes.base}</span>}
            </span>
          )}
        </div>
        <div class="segmented" role="tablist" aria-label="What to compare">
          {scopes.map((s) => (
            <button key={s.id} role="tab" aria-selected={scope === s.id} class={scope === s.id ? "on" : ""} title={s.hint(changes)} onClick={() => setScope(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div class="spacer" />
        <div class="totals">
          <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
          <DiffStat file={totals} />
        </div>
      </header>

      <div class="body">
        <aside class="sidebar">
          <div class="sidebar-head">
            <label class="switch">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.currentTarget.checked)} />
              <span>Show all files</span>
            </label>
          </div>
          {files.length === 0 && !showAll ? (
            <div class="sidebar-empty">No changes in this scope.</div>
          ) : (
            <Tree root={tree} selected={selected} collapsed={collapsed} onSelect={setSelected} onToggle={toggle} />
          )}
        </aside>
        <main class="main">
          {current ? <FilePane file={current} scope={scope} mode={mode} setMode={setMode} /> : <Notice title={files.length ? "Pick a file" : "Nothing changed"} body={files.length ? "j / k to move between files" : scopes.find((s) => s.id === scope)!.hint(changes)} />}
        </main>
      </div>
    </div>
  );
}

const modeKeys: Record<string, ViewMode> = { "1": "unified", "2": "split", "3": "full" };
const modes: { id: ViewMode; label: string }[] = [
  { id: "unified", label: "Unified" },
  { id: "split", label: "Split" },
  { id: "full", label: "Full file" },
];

function FilePane({ file, scope, mode, setMode }: { file: ChangedFile; scope: Scope; mode: ViewMode; setMode: (m: ViewMode) => void }) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const full = mode === "full";
  // Refetch when the file itself changes (mtime/stat), not just when another is picked.
  const version = `${file.path}|${file.mtime}|${file.added}|${file.deleted}`;

  useEffect(() => {
    let live = true;
    setError(null);
    api<FileDiff>(`/api/repos/${repoId}/diff?scope=${scope}&path=${encodeURIComponent(file.path)}${full ? "&full=1" : ""}`).then(
      (d) => live && setDiff(d),
      (e) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [version, scope, full]);

  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const stale = diff?.file.path !== file.path;
  return (
    <>
      <div class="file-head">
        <StatusBadge file={file} />
        <span class="file-path">
          <span class="muted">{dir}</span>
          {file.path.slice(dir.length)}
        </span>
        {file.oldPath && <span class="muted from">from {file.oldPath}</span>}
        <DiffStat file={file} />
        <div class="spacer" />
        <div class="segmented small" role="tablist" aria-label="Diff view">
          {modes.map((m, i) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} class={mode === m.id ? "on" : ""} title={`${m.label} (${i + 1})`} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {error ? <div class="diff-note">{error}</div> : !diff || stale ? <div class="diff-note muted">Loading…</div> : <DiffView diff={diff} mode={mode} onFullFile={() => setMode("full")} />}
    </>
  );
}

export function Notice({ title, body }: { title: string; body?: string }) {
  return (
    <div class="notice">
      <h1>{title}</h1>
      {body && <p>{body}</p>}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
