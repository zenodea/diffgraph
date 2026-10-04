import { escapeHtml, highlightLines, languageFor } from "./highlight.ts";

/** Just enough markdown for agent answers: fences, inline code, bold, lists, headings, paragraphs. */
export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      const lang = fence[1] ? languageFor(`x.${fence[1]}`) : null;
      out.push(`<pre><code>${highlightLines(code, lang).join("\n")}</code></pre>`);
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(`<p><strong>${inline(heading[1])}</strong></p>`);
    } else if (item) {
      if (para.length) flush();
      (list ??= []).push(item[1]);
    } else if (!line.trim()) flush();
    else if (list && /^\s{2,}/.test(line)) list[list.length - 1] += " " + line.trim();
    else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("");
}

function inline(s: string): string {
  // Code spans become placeholders first so **bold `code`** still works.
  const codes: string[] = [];
  const text = escapeHtml(s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}
