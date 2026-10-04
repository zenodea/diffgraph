import { useMemo, useState } from "preact/hooks";
import type { DiffLine, Hunk } from "../server/diff.ts";
import type { FileDiff } from "../server/fileDiff.ts";
import { EMPTY_TREE } from "../shared.ts";
import { repoId, token } from "./api.ts";
import { changedRange, highlightLines, languageFor, markRange } from "./highlight.ts";

export type ViewMode = "unified" | "split" | "full";

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

export function DiffView({ diff, mode, onFullFile }: { diff: FileDiff; mode: ViewMode; onFullFile: () => void }) {
  const hunks = useMemo(() => prepare(diff.hunks, diff.file.path), [diff]);
  const [forceLarge, setForceLarge] = useState(false);

  if (diff.binary) return <BinaryView diff={diff} />;
  if (diff.tooLarge) return <div class="diff-note">This diff is too large to show here.</div>;
  if (!hunks.length) {
    return <div class="diff-note">{diff.file.status === "R" ? "Renamed, content unchanged." : "No line changes (mode or whitespace only)."}</div>;
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
  let prevEnd = 1;
  return (
    <div class="diff-scroll">
      <table class="diff unified">
        <tbody>
          {hunks.map((h, hi) => {
            const header = <HunkHeader key={`h${hi}`} hunk={h} prevEnd={prevEnd} onFullFile={onFullFile} cols={4} />;
            prevEnd = h.newStart + h.newLines;
            return [
              header,
              ...h.lines.map((l, i) => (
                <tr key={`${hi}-${i}`} class={`ln t${l.t === " " ? "c" : l.t === "+" ? "a" : "d"}`} data-new={l.n ?? undefined} data-old={l.o ?? undefined}>
                  <td class="num">{l.o ?? ""}</td>
                  <td class="num">{l.n ?? ""}</td>
                  <td class="sign">{sign[l.t]}</td>
                  <Code line={l} />
                </tr>
              )),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function SplitView({ hunks, onFullFile }: { hunks: PreparedHunk[]; onFullFile: () => void }) {
  let prevEnd = 1;
  return (
    <div class="diff-scroll">
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
              ...rows.map(([a, b], ri) => (
                <tr key={`${hi}-${ri}`} class="ln" data-new={b?.n ?? undefined} data-old={a?.o ?? undefined}>
                  <td class={`num ${side(a)}`}>{a?.o ?? ""}</td>
                  {a ? <SideCode line={a} /> : <td class="code empty" />}
                  <td class={`num ${side(b)}`}>{b?.n ?? ""}</td>
                  {b ? <SideCode line={b} /> : <td class="code empty" />}
                </tr>
              )),
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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const lines = hunks.flatMap((h) => h.lines);
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
      <table class="diff full">
        <tbody>
          {items.map((it, idx) =>
            it.kind === "line" ? (
              <tr key={idx} class={`ln t${it.line.t === "+" ? "a" : "c"}`} data-new={it.line.n ?? undefined}>
                <td class="num">{it.line.n}</td>
                <td class="sign">{it.line.t === "+" ? "+" : " "}</td>
                <Code line={it.line} />
              </tr>
            ) : open.has(it.id) ? (
              [
                <tr key={it.id} class="ghost-toggle" onClick={() => toggle(it.id)}>
                  <td class="num" />
                  <td class="sign">▾</td>
                  <td class="code">hide {it.lines.length} removed</td>
                </tr>,
                ...it.lines.map((l, k) => (
                  <tr key={`${it.id}-${k}`} class="ln td ghost" data-old={l.o ?? undefined}>
                    <td class="num">{l.o}</td>
                    <td class="sign">−</td>
                    <Code line={l} />
                  </tr>
                )),
              ]
            ) : (
              <tr key={it.id} class="ghost-toggle" onClick={() => toggle(it.id)}>
                <td class="num" />
                <td class="sign">▸</td>
                <td class="code">{it.lines.length} removed {it.lines.length === 1 ? "line" : "lines"}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
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
