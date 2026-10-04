import hljs from "highlight.js/lib/common";

const MAX_HIGHLIGHT_CHARS = 300_000;

const extToLang: Record<string, string> = {
  mjs: "javascript", cjs: "javascript", jsx: "javascript", mts: "typescript", cts: "typescript",
  tsx: "typescript", yml: "yaml", toml: "ini", zsh: "bash", sh: "bash", h: "c", hpp: "cpp",
  md: "markdown", svelte: "xml", vue: "xml", html: "xml", svg: "xml",
};

export function languageFor(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  if (/^(Dockerfile|Containerfile)/.test(name)) return "dockerfile";
  if (name === "Makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const lang = extToLang[ext] ?? ext;
  return hljs.getLanguage(lang) ? lang : null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlights a block of lines together (so multi-line strings and comments stay
 * right) and returns one HTML string per line, re-opening spans that cross lines.
 */
export function highlightLines(lines: string[], lang: string | null): string[] {
  const code = lines.join("\n");
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return lines.map(escapeHtml);
  let html: string;
  try {
    html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return lines.map(escapeHtml);
  }
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  const tag = /<span[^>]*>|<\/span>|\n|[^<\n]+/g;
  for (const m of html.matchAll(tag)) {
    const tok = m[0];
    if (tok === "\n") {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (tok.startsWith("<span")) open.push(tok);
      else if (tok === "</span>") open.pop();
      line += tok;
    }
  }
  out.push(line);
  return out;
}

/** Char range [start, end) that differs between two versions of a line (common prefix/suffix trimmed). */
export function changedRange(a: string, b: string): { a: [number, number]; b: [number, number] } | null {
  if (a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Mostly-different lines read better without word marks.
  const shared = p + s;
  if (shared < Math.min(a.length, b.length) * 0.3) return null;
  return { a: [p, a.length - s], b: [p, b.length - s] };
}

/** Wraps visible chars [start, end) of highlighted HTML in <mark>, splitting around tags. */
export function markRange(html: string, start: number, end: number): string {
  if (start >= end) return html;
  let out = "";
  let pos = 0;
  let marking = false;
  const toks = /<[^>]+>|&[a-z#0-9]+;|[^<&]/g;
  for (const m of html.matchAll(toks)) {
    const tok = m[0];
    if (tok[0] === "<" && tok.length > 1) {
      if (marking) out += "</mark>" + tok + '<mark class="w">';
      else out += tok;
      continue;
    }
    if (pos === start) (out += '<mark class="w">'), (marking = true);
    out += tok;
    pos++;
    if (pos === end && marking) (out += "</mark>"), (marking = false);
  }
  if (marking) out += "</mark>";
  return out;
}
