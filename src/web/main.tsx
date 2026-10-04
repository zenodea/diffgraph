import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Changes } from "../server/changes.ts";
import type { Scope } from "../server/git.ts";
import type { ReviewedFile } from "../server/review.ts";
import { api, repoId, type Repo } from "./api.ts";
import type { ViewMode } from "./DiffView.tsx";
import { FilePane } from "./FilePane.tsx";
import { readHashPath, useHashPath, useKeys, usePersisted } from "./hooks.ts";
import { Check } from "./icons.tsx";
import { useLive, useTick, type Live } from "./live.ts";
import { DiffStat, Tree } from "./Tree.tsx";
import { buildTree, visibleOrder } from "./tree.ts";
import { ago, plural } from "./util.ts";
import "./styles.css";

type Reviewed = Omit<Changes, "files"> & { files: ReviewedFile[] };

const scopes: { id: Scope; label: string; hint: (c: Reviewed) => string; available?: (c: Reviewed) => boolean }[] = [
  {
    id: "branch",
    label: "Branch",
    hint: (c) => (c.base ? `Everything since ${c.branch ?? "HEAD"} left ${c.base}, plus uncommitted work` : "No base branch found: showing uncommitted work"),
  },
  { id: "uncommitted", label: "Uncommitted", hint: () => "Only what isn't committed yet (staged, unstaged, new files)" },
  {
    id: "session",
    label: "This session",
    hint: (c) =>
      c.session
        ? `Files the ${c.session.agent} agent in this pane edited since its session started${c.session.startedAt ? ` ${ago(Date.parse(c.session.startedAt))}` : ""} (${plural(c.session.prompts, "prompt")})`
        : "Needs the transcript of the agent in this pane (Claude Code, Codex or pi); none was found",
    available: (c) => !!c.session,
  },
];

const modeKeys: Record<string, ViewMode> = { "1": "unified", "2": "split", "3": "full" };

function App() {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [scope, setScope] = usePersisted<Scope>("scope", "branch");
  const [changes, setChanges] = useState<Reviewed | null>(null);
  const [showAll, setShowAll] = usePersisted("showAll", false);
  const [hideReviewed, setHideReviewed] = usePersisted("hideReviewed", false);
  const [allPaths, setAllPaths] = useState<string[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useHashPath();
  const [mode, setMode] = usePersisted<ViewMode>("mode", "unified");

  const [recent, setRecent] = useState<Map<string, number>>(new Map());

  const load = () =>
    api<Reviewed>(`/api/repos/${repoId}/changes?scope=${scope}`).then(setChanges, (e) => {
      if (scope === "session") {
        setToast(e.message);
        setScope("branch");
      } else setError(e.message);
    });
  const live = useLive((paths) => {
    if (repo) load();
    if (!paths.length) return;
    const next = new Map(recent);
    for (const p of paths) next.set(p, Date.now());
    setRecent(next);
  });
  useTick(15_000);

  useEffect(() => {
    api<Repo>(`/api/repos/${repoId}`).then(setRepo, (e) => setError(e.message));
  }, []);
  useEffect(() => void (repo && load()), [repo, scope]);
  useEffect(() => {
    if (showAll && !allPaths) api<{ paths: string[] }>(`/api/repos/${repoId}/files`).then((r) => setAllPaths(r.paths));
  }, [showAll]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const files = changes?.files ?? [];
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const tree = useMemo(() => {
    let paths = showAll && allPaths ? [...new Set([...allPaths, ...byPath.keys()])] : [...byPath.keys()];
    // Keep the open file in the tree even when it's reviewed, so it doesn't vanish under you.
    if (hideReviewed) paths = paths.filter((p) => byPath.get(p)?.review !== "reviewed" || p === selected);
    return buildTree(paths, byPath);
  }, [byPath, showAll, allPaths, hideReviewed, selected]);

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
  const done = files.filter((f) => f.review === "reviewed").length;
  const left = files.length - done;

  /** Next file still needing review, after the current one in tree order (wrapping). */
  const nextUnreviewed = (from = readHashPath()) => {
    const all = visibleOrder(buildTree([...byPath.keys()], byPath), new Set());
    const i = all.findIndex((f) => f.path === from);
    return [...all.slice(i + 1), ...all.slice(0, Math.max(i, 0))].find((f) => f.review !== "reviewed") ?? null;
  };

  // Land on the first file that needs review instead of an empty pane.
  useEffect(() => {
    if (changes && !current && files.length) setSelected((nextUnreviewed(null) ?? order[0])?.path ?? null);
  }, [changes]);

  const review = async (targets: ReviewedFile[], reviewed: boolean, advance = false) => {
    if (!changes) return;
    // Optimistic: the tick shows up straight away.
    const paths = new Set(targets.map((f) => f.path));
    setChanges({ ...changes, files: files.map((f) => (paths.has(f.path) ? { ...f, review: reviewed ? "reviewed" : null, reviewedAt: reviewed ? Date.now() : null } : f)) });
    if (advance && reviewed) {
      const next = nextUnreviewed();
      if (next && !paths.has(next.path)) setSelected(next.path);
    }
    try {
      await api(`/api/repos/${repoId}/review`, { body: { reviewed, files: targets.map((f) => ({ path: f.path, mtime: f.mtime })) } });
    } catch (e) {
      setToast((e as Error).message);
    }
    load();
  };

  useKeys((e) => {
    // The hash updates synchronously, so fast repeats don't act on a stale selection.
    const i = order.findIndex((f) => f.path === readHashPath());
    const cur = byPath.get(readHashPath() ?? "");
    if (e.key === "j") order[i + 1] && setSelected(order[i + 1].path);
    else if (e.key === "k") order[i - 1] && setSelected(order[i - 1].path);
    else if (e.key === "n") {
      const next = nextUnreviewed();
      next && setSelected(next.path);
    } else if (e.key === " " && cur) review([cur], cur.review !== "reviewed", true);
    else if (e.key === "h") setHideReviewed(!hideReviewed);
    else if (e.key in modeKeys) setMode(modeKeys[e.key]);
    else return;
    e.preventDefault();
  });

  useEffect(() => {
    document.querySelector(".row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (error) return <Notice title="Can't open this repo" body={error} />;
  if (!repo || !changes) return <Notice title="Loading…" />;
  document.title = `${left ? `(${left}) ` : ""}${repo.name} · graphdiff`;

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
            <button
              key={s.id}
              role="tab"
              aria-selected={scope === s.id}
              class={scope === s.id ? "on" : ""}
              title={s.hint(changes)}
              disabled={s.available && !s.available(changes) && scope !== s.id}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div class="spacer" />
        <div class="totals">
          <span>{plural(files.length, "file")}</span>
          <DiffStat file={totals} />
        </div>
        <LiveStatus live={live} />
        {files.length > 0 && <Progress done={done} total={files.length} onNext={() => { const n = nextUnreviewed(); n && setSelected(n.path); }} />}
      </header>

      <div class="body">
        <aside class="sidebar">
          <div class="sidebar-head">
            <label class="switch" title="h">
              <input type="checkbox" checked={hideReviewed} onChange={(e) => setHideReviewed(e.currentTarget.checked)} />
              <span>Hide reviewed</span>
            </label>
            <label class="switch">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.currentTarget.checked)} />
              <span>All files</span>
            </label>
          </div>
          {files.length === 0 && !showAll ? (
            <div class="sidebar-empty">No changes in this scope.</div>
          ) : (
            <Tree root={tree} selected={selected} collapsed={collapsed} onSelect={setSelected} onToggle={toggle} onReview={(fs, r) => review(fs, r)} hideReviewed={hideReviewed} recent={recent} />
          )}
          <div class="keys-hint">
            <span><kbd>j</kbd> <kbd>k</kbd> move</span>
            <span><kbd>n</kbd> next to review</span>
            <span><kbd>space</kbd> reviewed</span>
            <span><kbd>h</kbd> hide reviewed</span>
          </div>
        </aside>
        <main class="main">
          {live.superseded && (
            <div class="banner info">
              <span>graphdiff opened this repo in a newer tab. You can close this one.</span>
              <button class="link" onClick={live.dismissSuperseded}>
                Keep using this tab
              </button>
            </div>
          )}
          {current ? (
            <FilePane file={current} scope={scope} mode={mode} setMode={setMode} onReview={(r) => review([current], r, true)} />
          ) : (
            <Notice title="Nothing changed" body={scopes.find((s) => s.id === scope)!.hint(changes)} />
          )}
        </main>
      </div>
      {toast && (
        <div class="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}

function LiveStatus({ live }: { live: Live }) {
  const [name, status] = live.agent?.split(":") ?? [];
  const working = status === "working";
  const label = !live.connected ? "Reconnecting…" : name ? `${name} ${status === "done" || status === "idle" ? "is idle" : status === "blocked" ? "needs you" : status === "working" ? "is working" : status}` : "Live";
  const title = !live.connected
    ? "Lost the connection to the graphdiff server. It reconnects by itself; if it doesn't, press prefix+g in herdr."
    : working
      ? "The agent is still working, so more changes may arrive. The page updates by itself."
      : "Updates by itself as files change";
  return (
    <span class={`live ${live.connected ? "on" : "off"} ${working ? "working" : ""} ${status === "blocked" ? "blocked" : ""}`} title={title}>
      <span class="dot" />
      {label}
    </span>
  );
}

function Progress({ done, total, onNext }: { done: number; total: number; onNext: () => void }) {
  const all = done === total;
  return (
    <div class={`progress ${all ? "all" : ""}`}>
      <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${(done / total) * 100}%` }} />
      </div>
      {all ? (
        <span class="progress-label">
          <Check /> All {total} reviewed
        </span>
      ) : (
        <>
          <span class="progress-label">
            <b>{total - done}</b> to review <span class="muted">· {done}/{total} done</span>
          </span>
          <button class="btn small" onClick={onNext} title="Next file to review (n)">
            Next <kbd>n</kbd>
          </button>
        </>
      )}
    </div>
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
