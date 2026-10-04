import { createContext, type ComponentChildren } from "preact";
import { useContext, useMemo, useState } from "preact/hooks";
import type { Thread } from "../server/ask.ts";
import type { DiffLine, Hunk } from "../server/diff.ts";
import type { FileDiff } from "../server/fileDiff.ts";
import { EMPTY_TREE } from "../shared.ts";
import { repoId, token } from "./api.ts";
import { changedRange, highlightLines, languageFor, markRange } from "./highlight.ts";

export type ViewMode = "unified" | "split" | "full";

export const lineKey = (l: DiffLine) => `${l.o ?? ""}:${l.n ?? ""}`;

/** Selection and question threads, shared by all three views. */
export interface DiffInteraction {
  selected: Set<string>;
  onLine: (line: DiffLine, extend: boolean) => void;
  threads: Thread[];
  renderThread: (t: Thread, outdated: boolean) => ComponentChildren;
}

const Interaction = createContext<DiffInteraction>({ selected: new Set(), onLine: () => {}, threads: [], renderThread: () => null });

/** Which line each thread sits under; threads whose lines are gone stay unplaced. */
function placeThreads(threads: Thread[], lines: DiffLine[], keyFor: (l: DiffLine) => string = lineKey) {
  const at = new Map<string, Thread[]>();
  const unplaced: Thread[] = [];
  for (const t of threads) {
    const a = t.anchor;
    const line = a && lines.find((l) => (a.side === "new" ? l.n === a.end : l.o === a.end && l.t === "-"));
    if (!line) unplaced.push(t);
    else {
      const k = keyFor(line);
      at.set(k, [...(at.get(k) ?? []), t]);
    }
  }
  return { at, unplaced };
}

function ThreadRows({ threads, cols }: { threads: Thread[] | undefined; cols: number }) {
  const ctx = useContext(Interaction);
  if (!threads?.length) return null;
  return (
    <>
      {threads.map((t) => (
        <tr key={t.id} class="thread-row">
          <td colSpan={cols}>{ctx.renderThread(t, false)}</td>
        </tr>
      ))}
    </>
  );
}

function Unplaced({ threads }: { threads: Thread[] }) {
  const ctx = useContext(Interaction);
  if (!threads.length) return null;
  return <div class="unplaced">{threads.map((t) => <div key={t.id}>{ctx.renderThread(t, !!t.anchor)}</div>)}</div>;
}

function Num({ line, class: cls = "", children }: { line: DiffLine | null; class?: string; children: ComponentChildren }) {
  const ctx = useContext(Interaction);
  if (!line) return <td class={`num ${cls}`} />;
  return (
    <td
      class={`num pick ${cls}`}
      title="Click to select, shift-click for a range, then ask about it"
      // Keep focus in the question box while picking lines.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => ctx.onLine(line, e.shiftKey)}
    >
      {children}
    </td>
  );
}

interface Line extends DiffLine {
  html: string;
}

interface PreparedHunk extends Omit<Hunk, "lines"> {
  lines: Line[];
}

/** Highlights each hunk's old and new side as whole blocks, then adds word-level marks to paired -/+ lines. */
function prepare(hunks: Hunk[], path: string): PreparedHunk[] {
  const lang = languageFor(path);
  return hunks.map((h) => {
    const oldIdx: number[] = [];
    const newIdx: number[] = [];
    h.lines.forEach((l, i) => {
      if (l.t !== "+") oldIdx.push(i);
      if (l.t !== "-") newIdx.push(i);
    });
    const oldHtml = highlightLines(oldIdx.map((i) => h.lines[i].s), lang);
    const newHtml = highlightLines(newIdx.map((i) => h.lines[i].s), lang);
    const html: string[] = new Array(h.lines.length);
    newIdx.forEach((i, k) => (html[i] = newHtml[k]));
    oldIdx.forEach((i, k) => h.lines[i].t === "-" && (html[i] = oldHtml[k]));

    for (const { dels, adds } of changeRuns(h.lines)) {
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const r = changedRange(h.lines[dels[k]].s, h.lines[adds[k]].s);
        if (!r) continue;
        html[dels[k]] = markRange(html[dels[k]], ...r.a);
        html[adds[k]] = markRange(html[adds[k]], ...r.b);
      }
    }
    return { ...h, lines: h.lines.map((l, i) => ({ ...l, html: html[i] })) };
  });
}

/** Consecutive "-" lines followed by "+" lines: a replaced block. */
function changeRuns(lines: DiffLine[]): { dels: number[]; adds: number[] }[] {
  const runs: { dels: number[]; adds: number[] }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].t === " ") {
      i++;
      continue;
    }
    const run = { dels: [] as number[], adds: [] as number[] };
    while (i < lines.length && lines[i].t === "-") run.dels.push(i++);
    while (i < lines.length && lines[i].t === "+") run.adds.push(i++);
    runs.push(run);
  }
  return runs;
}

export function DiffView({ diff, mode, onFullFile, interaction }: { diff: FileDiff; mode: ViewMode; onFullFile: () => void; interaction: DiffInteraction }) {
  const hunks = useMemo(() => prepare(diff.hunks, diff.file.path), [diff]);
  const [forceLarge, setForceLarge] = useState(false);

  return (
    <Interaction.Provider value={interaction}>
      <DiffBody diff={diff} hunks={hunks} mode={mode} onFullFile={onFullFile} forceLarge={forceLarge} setForceLarge={setForceLarge} />
    </Interaction.Provider>
  );
}

function DiffBody({ diff, hunks, mode, onFullFile, forceLarge, setForceLarge }: { diff: FileDiff; hunks: PreparedHunk[]; mode: ViewMode; onFullFile: () => void; forceLarge: boolean; setForceLarge: (v: boolean) => void }) {
  const ctx = useContext(Interaction);
  // No lines to hang questions on: show them all above the note.
  const note = (body: ComponentChildren) => (
    <>
      <Unplaced threads={ctx.threads} />
      {body}
    </>
  );
  if (diff.binary) return note(<BinaryView diff={diff} />);
  if (diff.tooLarge) return note(<div class="diff-note">This diff is too large to show here.</div>);
  if (!hunks.length) {
    return note(<div class="diff-note">{diff.file.status === "R" ? "Renamed, content unchanged." : "No line changes (mode or whitespace only)."}</div>);
  }
  const lineCount = hunks.reduce((n, h) => n + h.lines.length, 0);
  if (lineCount > 6000 && !forceLarge) {
    return (
      <div class="diff-note">
        {lineCount.toLocaleString()} lines. <button class="link" onClick={() => setForceLarge(true)}>Show anyway</button>
      </div>
    );
  }

  if (mode === "split") return <SplitView hunks={hunks} onFullFile={onFullFile} />;
  if (mode === "full") return <FullView hunks={hunks} />;
  return <UnifiedView hunks={hunks} onFullFile={onFullFile} />;
}

function HunkHeader({ hunk, prevEnd, onFullFile, cols }: { hunk: PreparedHunk; prevEnd: number; onFullFile: () => void; cols: number }) {
  const hidden = hunk.newStart - prevEnd;
  const end = hunk.newStart + Math.max(hunk.newLines - 1, 0);
  return (
    <tr class="hunk-row">
      <td colSpan={cols}>
        {hidden > 0 && (
          <button class="link gap" onClick={onFullFile} title="Switch to full file (3)">
            ⋯ {hidden} unchanged {hidden === 1 ? "line" : "lines"}
          </button>
        )}
        <span class="hunk-range">
          {hunk.newLines ? `Lines ${hunk.newStart}–${end}` : hunk.newStart === 0 ? "Whole file removed" : `Removed after line ${hunk.newStart}`}
        </span>
        {hunk.context && <span class="hunk-ctx">{hunk.context.trim()}</span>}
      </td>
    </tr>
  );
}

function Code({ line }: { line: Line }) {
  return <td class="code" dangerouslySetInnerHTML={{ __html: line.html || " " }} />;
}

const sign = { " ": " ", "+": "+", "-": "−" };

function UnifiedView({ hunks, onFullFile }: { hunks: PreparedHunk[]; onFullFile: () => void }) {
  const ctx = useContext(Interaction);
  const { at, unplaced } = placeThreads(ctx.threads, hunks.flatMap((h) => h.lines));
  let prevEnd = 1;
  return (
    <div class="diff-scroll">
      <Unplaced threads={unplaced} />
      <table class="diff unified">
        <tbody>
          {hunks.map((h, hi) => {
            const header = <HunkHeader key={`h${hi}`} hunk={h} prevEnd={prevEnd} onFullFile={onFullFile} cols={4} />;
            prevEnd = h.newStart + h.newLines;
            return [
              header,
              ...h.lines.map((l, i) => [
                <tr key={`${hi}-${i}`} class={`ln t${l.t === " " ? "c" : l.t === "+" ? "a" : "d"} ${ctx.selected.has(lineKey(l)) ? "sel" : ""}`} data-new={l.n ?? undefined} data-old={l.o ?? undefined}>
                  <Num line={l}>{l.o ?? ""}</Num>
                  <Num line={l}>{l.n ?? ""}</Num>
                  <td class="sign">{sign[l.t]}</td>
                  <Code line={l} />
                </tr>,
                <ThreadRows key={`t${hi}-${i}`} threads={at.get(lineKey(l))} cols={4} />,
              ]),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function SplitView({ hunks, onFullFile }: { hunks: PreparedHunk[]; onFullFile: () => void }) {
  const ctx = useContext(Interaction);
  const { at, unplaced } = placeThreads(ctx.threads, hunks.flatMap((h) => h.lines));
  let prevEnd = 1;
  return (
    <div class="diff-scroll">
      <Unplaced threads={unplaced} />
      <table class="diff split">
        <colgroup>
          <col class="num-col" /><col /><col class="num-col" /><col />
        </colgroup>
        <tbody>
          {hunks.map((h, hi) => {
            const header = <HunkHeader key={`h${hi}`} hunk={h} prevEnd={prevEnd} onFullFile={onFullFile} cols={4} />;
            prevEnd = h.newStart + h.newLines;
            const rows: [Line | null, Line | null][] = [];
            let i = 0;
            while (i < h.lines.length) {
              const l = h.lines[i];
              if (l.t === " ") {
                rows.push([l, l]);
                i++;
                continue;
              }
              const dels: Line[] = [];
              const adds: Line[] = [];
              while (i < h.lines.length && h.lines[i].t === "-") dels.push(h.lines[i++]);
              while (i < h.lines.length && h.lines[i].t === "+") adds.push(h.lines[i++]);
              for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
            }
            return [
              header,
              ...rows.map(([a, b], ri) => {
                const sel = (a && ctx.selected.has(lineKey(a))) || (b && ctx.selected.has(lineKey(b)));
                const here = [...new Set([...(a ? at.get(lineKey(a)) ?? [] : []), ...(b && b !== a ? at.get(lineKey(b)) ?? [] : [])])];
                return [
                  <tr key={`${hi}-${ri}`} class={`ln ${sel ? "sel" : ""}`} data-new={b?.n ?? undefined} data-old={a?.o ?? undefined}>
                    <Num line={a} class={side(a)}>{a?.o ?? ""}</Num>
                    {a ? <SideCode line={a} /> : <td class="code empty" />}
                    <Num line={b} class={side(b)}>{b?.n ?? ""}</Num>
                    {b ? <SideCode line={b} /> : <td class="code empty" />}
                  </tr>,
                  <ThreadRows key={`t${hi}-${ri}`} threads={here} cols={4} />,
                ];
              }),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

const side = (l: Line | null) => (!l ? "empty" : l.t === "+" ? "ta" : l.t === "-" ? "td" : "tc");

function SideCode({ line }: { line: Line }) {
  return <td class={`code ${side(line)}`} dangerouslySetInnerHTML={{ __html: line.html || " " }} />;
}

/** Whole new file; removed lines fold into a "n removed" row you can open. */
function FullView({ hunks }: { hunks: PreparedHunk[] }) {
  const ctx = useContext(Interaction);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const lines = hunks.flatMap((h) => h.lines);
  // Threads on removed lines sit under their (possibly folded) removed block.
  const blockOf = new Map<string, string>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i].t !== "-") {
      i++;
      continue;
    }
    const id = `r${lines[i].o}`;
    while (i < lines.length && lines[i].t === "-") blockOf.set(lineKey(lines[i++]), id);
  }
  const { at, unplaced } = placeThreads(ctx.threads, lines, (l) => blockOf.get(lineKey(l)) ?? lineKey(l));
  const items: ({ kind: "line"; line: Line } | { kind: "removed"; id: string; lines: Line[] })[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].t !== "-") {
      items.push({ kind: "line", line: lines[i++] });
      continue;
    }
    const removed: Line[] = [];
    while (i < lines.length && lines[i].t === "-") removed.push(lines[i++]);
    items.push({ kind: "removed", id: `r${removed[0].o}`, lines: removed });
  }
  const total = items.length;
  const jump = (idx: number) =>
    document.querySelectorAll(".diff.full tbody > tr")[rowIndex(items, open, idx)]?.scrollIntoView({ block: "center" });
  const toggle = (id: string) => {
    const next = new Set(open);
    next.has(id) ? next.delete(id) : next.add(id);
    setOpen(next);
  };

  return (
    <div class="diff-scroll full-wrap">
      <div>
      <Unplaced threads={unplaced} />
      <table class="diff full">
        <tbody>
          {items.map((it, idx) =>
            it.kind === "line" ? (
              [
                <tr key={idx} class={`ln t${it.line.t === "+" ? "a" : "c"} ${ctx.selected.has(lineKey(it.line)) ? "sel" : ""}`} data-new={it.line.n ?? undefined}>
                  <Num line={it.line}>{it.line.n}</Num>
                  <td class="sign">{it.line.t === "+" ? "+" : " "}</td>
                  <Code line={it.line} />
                </tr>,
                <ThreadRows key={`t${idx}`} threads={at.get(lineKey(it.line))} cols={3} />,
              ]
            ) : open.has(it.id) ? (
              [
                <tr key={it.id} class="ghost-toggle" onClick={() => toggle(it.id)}>
                  <td class="num" />
                  <td class="sign">▾</td>
                  <td class="code">hide {it.lines.length} removed</td>
                </tr>,
                ...it.lines.map((l, k) => (
                  <tr key={`${it.id}-${k}`} class={`ln td ghost ${ctx.selected.has(lineKey(l)) ? "sel" : ""}`} data-old={l.o ?? undefined}>
                    <Num line={l}>{l.o}</Num>
                    <td class="sign">−</td>
                    <Code line={l} />
                  </tr>
                )),
                <ThreadRows key={`t${it.id}`} threads={at.get(it.id)} cols={3} />,
              ]
            ) : (
              [
                <tr key={it.id} class="ghost-toggle" onClick={() => toggle(it.id)}>
                  <td class="num" />
                  <td class="sign">▸</td>
                  <td class="code">{it.lines.length} removed {it.lines.length === 1 ? "line" : "lines"}</td>
                </tr>,
                <ThreadRows key={`t${it.id}`} threads={at.get(it.id)} cols={3} />,
              ]
            ),
          )}
        </tbody>
      </table>
      </div>
      <div class="ruler-track" aria-hidden="true">
        <div class="ruler">
          {items.map((it, idx) =>
            it.kind === "removed" || it.line.t === "+" ? (
              <span key={idx} class={it.kind === "removed" ? "rd" : "ra"} style={{ top: `${(idx / total) * 100}%` }} onClick={() => jump(idx)} />
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

/** Table row of item `idx`, counting the extra rows of opened removed blocks. */
function rowIndex(items: { kind: string; id?: string; lines?: unknown[] }[], open: Set<string>, idx: number): number {
  let row = 0;
  for (let i = 0; i < idx; i++) row += items[i].kind === "removed" && open.has(items[i].id!) ? 1 + items[i].lines!.length : 1;
  return row;
}

function BinaryView({ diff }: { diff: FileDiff }) {
  const f = diff.file;
  const isImage = /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(f.path);
  if (!isImage) return <div class="diff-note">Binary file {f.status === "A" ? "added" : f.status === "D" ? "deleted" : "changed"}.</div>;
  const src = (path: string, rev?: string) =>
    `/api/repos/${repoId}/image?path=${encodeURIComponent(path)}${rev ? `&rev=${rev}` : ""}&t=${token}`;
  const hasBefore = f.status !== "A" && diff.from !== EMPTY_TREE;
  return (
    <div class="image-diff">
      {hasBefore && (
        <figure>
          <figcaption>Before</figcaption>
          <img src={src(f.oldPath ?? f.path, diff.from)} alt="before" />
        </figure>
      )}
      {f.status !== "D" && (
        <figure>
          <figcaption>{hasBefore ? "After" : "New"}</figcaption>
          <img src={src(f.path)} alt="after" />
        </figure>
      )}
    </div>
  );
}
