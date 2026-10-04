export type LineType = " " | "+" | "-";

export interface DiffLine {
  t: LineType;
  /** Line number in the old / new file; null on the side the line doesn't exist. */
  o: number | null;
  n: number | null;
  s: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Function/section context git prints after the @@ range. */
  context: string;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parses the hunks of a single-file unified diff (headers are skipped). */
export function parseDiff(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let o = 0;
  let n = 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = HUNK.exec(line);
    if (m) {
      o = Number(m[1]);
      n = Number(m[3]);
      hunk = {
        oldStart: o,
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: n,
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        context: m[5] ?? "",
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const t = line[0];
    if (t === " ") hunk.lines.push({ t, o: o++, n: n++, s: line.slice(1) });
    else if (t === "-") hunk.lines.push({ t, o: o++, n: null, s: line.slice(1) });
    else if (t === "+") hunk.lines.push({ t, o: null, n: n++, s: line.slice(1) });
    // "\ No newline at end of file" and anything else is ignored.
  }
  return hunks;
}
