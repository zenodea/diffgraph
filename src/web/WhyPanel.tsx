import { useEffect, useState } from "preact/hooks";
import type { Scope } from "../server/git.ts";
import type { WhyEntry } from "../server/why.ts";
import { api, repoId } from "./api.ts";
import { usePersisted } from "./hooks.ts";
import { ago, plural } from "./util.ts";

/** The prompts that led an agent to edit this file, newest first, with what it said before editing. */
export function WhyPanel({ path, scope, version }: { path: string; scope: Scope; version: string }) {
  const [entries, setEntries] = useState<WhyEntry[] | null>(null);
  const [open, setOpen] = usePersisted("whyOpen", true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => setShowAll(false), [path]);
  useEffect(() => {
    let live = true;
    api<{ entries: WhyEntry[] }>(`/api/repos/${repoId}/why?scope=${scope}&path=${encodeURIComponent(path)}`).then(
      (r) => live && setEntries(r.entries),
      () => live && setEntries([]),
    );
    return () => void (live = false);
  }, [version, scope]);

  if (!entries?.length) return null;
  const shown = showAll ? entries : entries.slice(0, 1);
  return (
    <section class={`why ${open ? "" : "closed"}`} aria-label="Why this changed">
      <button class="why-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class={`chevron ${open ? "open" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        Why this changed
        <span class="muted">· {plural(entries.length, "prompt")}</span>
      </button>
      {open && (
        <div class="why-body">
          {shown.map((e, i) => (
            <WhyItem key={i} entry={e} />
          ))}
          {entries.length > 1 && (
            <button class="link why-more" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show only the latest" : `Show ${plural(entries.length - 1, "earlier prompt")}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function WhyItem({ entry }: { entry: WhyEntry }) {
  const [expanded, setExpanded] = useState(false);
  const reason = entry.reasons[entry.reasons.length - 1];
  return (
    <article class={`why-item ${expanded ? "expanded" : ""}`} onClick={() => setExpanded(!expanded)} title={expanded ? "" : "Click to read in full"}>
      <div class="why-meta">
        <span class="agent-tag">{entry.agent}</span>
        {entry.current && <span class="current-tag">this session</span>}
        <span>{ago(Date.parse(entry.lastEditAt))}</span>
        <span>· {plural(entry.edits, "edit")}</span>
      </div>
      <p class="why-prompt">
        <span class="who">You</span>
        {entry.prompt}
      </p>
      {reason && (
        <p class="why-reason">
          <span class="who">{entry.agent}</span>
          {expanded ? entry.reasons.join("\n\n") : reason}
        </p>
      )}
    </article>
  );
}
