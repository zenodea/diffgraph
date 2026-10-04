// Who imports whom, for the map: links between changed files, plus the unchanged
// files that import them (how far a change could reach). Static and regex-based,
// so it's fast and needs no toolchain: TS/JS (relative imports and simple tsconfig
// path aliases), Python (relative and package imports) and Go (module packages).
import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { allFiles } from "../git/git.ts";

export interface DepEdge {
  /** The importing file. */
  from: string;
  /** The imported file. */
  to: string;
}

export interface Deps {
  edges: DepEdge[];
  /** Unchanged files that import a changed one. */
  dependents: string[];
}

const JS = /\.(m|c)?[jt]sx?$|\.(vue|svelte)$/;
const SOURCE = /\.((m|c)?[jt]sx?|vue|svelte|py|go)$/;
const MAX_FILES = 8000;
const MAX_BYTES = 512 * 1024;
const MAX_DEPENDENTS = 30;
const MAX_PER_TARGET = 6;

const parseCache = new Map<string, { key: string; specs: string[] }>();

/** Raw import specifiers in a file (cached by mtime and size). */
async function specifiers(root: string, path: string): Promise<string[]> {
  const abs = join(root, path);
  let key: string;
  try {
    const s = await stat(abs);
    if (s.size > MAX_BYTES) return [];
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    return [];
  }
  const hit = parseCache.get(abs);
  if (hit?.key === key) return hit.specs;
  const text = await readFile(abs, "utf8").catch(() => "");
  const specs = path.endsWith(".py") ? pythonSpecs(text) : path.endsWith(".go") ? goSpecs(text) : jsSpecs(text);
  parseCache.set(abs, { key, specs });
  return specs;
}

function all(text: string, re: RegExp, group = 1): string[] {
  return [...text.matchAll(re)].map((m) => m[group]).filter(Boolean);
}

export function jsSpecs(text: string): string[] {
  return [
    ...all(text, /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]/g),
    ...all(text, /(?:^|[\s;])import\s*['"]([^'"\n]+)['"]/g),
    ...all(text, /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g),
    ...all(text, /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g),
  ];
}

/** "py:<dots>:<module>" for `from ..a.b import c` (also tries a.b.c), "py::a.b" for `import a.b`. */
export function pythonSpecs(text: string): string[] {
  const out: string[] = [];
  // Names stay on the line unless they're in parentheses.
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w \t,*]+))/gm)) {
    out.push(`py:${m[1].length}:${m[2]}`);
    for (const name of (m[3] ?? m[4]).split(",").map((n) => n.trim().split(/\s+/)[0]).filter((n) => n && n !== "*")) {
      out.push(`py:${m[1].length}:${m[2] ? `${m[2]}.${name}` : name}`);
    }
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm)) {
    for (const mod of m[1].split(",")) out.push(`py:0:${mod.trim()}`);
  }
  return out;
}

export function goSpecs(text: string): string[] {
  const out = all(text, /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm);
  for (const block of all(text, /^\s*import\s*\(([\s\S]*?)\)/gm)) out.push(...all(block, /"([^"]+)"/g));
  return out.map((s) => `go:${s}`);
}

interface Resolver {
  files: Set<string>;
  goModule: string | null;
  goDirs: Map<string, string[]>;
  aliases: { prefix: string; targets: string[] }[];
}

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];

function resolveJs(r: Resolver, from: string, spec: string): string[] {
  let bases: string[];
  if (spec.startsWith(".")) bases = [posix.normalize(posix.join(posix.dirname(from), spec))];
  else {
    const alias = r.aliases.find((a) => spec.startsWith(a.prefix));
    if (!alias) return [];
    bases = alias.targets.map((t) => posix.normalize(t + spec.slice(alias.prefix.length)));
  }
  for (const base of bases) {
    const candidates = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
    // ESM TypeScript imports "./x.js" for "./x.ts".
    const m = /\.(m|c)?jsx?$/.exec(base);
    if (m) candidates.push(...JS_EXTS.slice(0, 4).map((e) => base.slice(0, -m[0].length) + e));
    const hit = candidates.find((c) => r.files.has(c));
    if (hit) return [hit];
  }
  return [];
}

function resolvePy(r: Resolver, from: string, spec: string): string[] {
  const [, dots, mod] = spec.split(":");
  const rel = mod.split(".").filter(Boolean).join("/");
  const roots: string[] = [];
  if (Number(dots) > 0) {
    let dir = posix.dirname(from);
    for (let i = 1; i < Number(dots); i++) dir = posix.dirname(dir);
    roots.push(dir === "." ? "" : dir);
  } else {
    // Package imports resolve from the repo root, src/, or any folder above the file.
    roots.push("", "src");
    for (let d = posix.dirname(from); d && d !== "."; d = posix.dirname(d)) roots.push(d);
  }
  for (const root of roots) {
    const base = root ? (rel ? `${root}/${rel}` : root) : rel;
    if (!base) continue;
    const hit = [`${base}.py`, `${base}/__init__.py`].find((c) => r.files.has(c));
    if (hit) return [hit];
  }
  return [];
}

function resolveGo(r: Resolver, spec: string): string[] {
  const pkg = spec.slice(3);
  if (!r.goModule || !(pkg === r.goModule || pkg.startsWith(r.goModule + "/"))) return [];
  return r.goDirs.get(pkg.slice(r.goModule.length + 1)) ?? [];
}

function resolve(r: Resolver, from: string, spec: string): string[] {
  if (spec.startsWith("py:")) return resolvePy(r, from, spec);
  if (spec.startsWith("go:")) return resolveGo(r, spec);
  return JS.test(from) ? resolveJs(r, from, spec) : [];
}

async function resolver(root: string, files: string[]): Promise<Resolver> {
  const goModule = (await readFile(join(root, "go.mod"), "utf8").catch(() => "")).match(/^module\s+(\S+)/m)?.[1] ?? null;
  const goDirs = new Map<string, string[]>();
  for (const f of files) {
    if (!f.endsWith(".go") || f.endsWith("_test.go")) continue;
    const d = posix.dirname(f) === "." ? "" : posix.dirname(f);
    goDirs.set(d, [...(goDirs.get(d) ?? []), f]);
  }
  return { files: new Set(files), goModule, goDirs, aliases: await tsAliases(root) };
}

/** `compilerOptions.paths` like {"@/*": ["src/*"]} from the root tsconfig.json. */
async function tsAliases(root: string): Promise<Resolver["aliases"]> {
  try {
    const raw = await readFile(join(root, "tsconfig.json"), "utf8");
    const json = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1"));
    const base = posix.normalize(json.compilerOptions?.baseUrl ?? ".");
    return Object.entries<string[]>(json.compilerOptions?.paths ?? {}).map(([k, v]) => ({
      prefix: k.replace(/\*$/, ""),
      targets: v.map((t) => posix.join(base, t.replace(/\*$/, "")).replace(/^\.\//, "")),
    }));
  } catch {
    return [];
  }
}

/** Import links among `changed` files, and the unchanged files that import them (capped, for the map). */
export async function dependencies(root: string, changed: string[]): Promise<Deps> {
  const { edges, dependents } = await importGraph(root, changed);
  return { edges, dependents };
}

/** Like `dependencies`, plus every file importing each changed file (uncapped, for risk checks). */
export async function importGraph(root: string, changed: string[]): Promise<Deps & { importers: Map<string, string[]> }> {
  const listing = (await allFiles(root)).filter((f) => SOURCE.test(f));
  const sources = listing.length > MAX_FILES ? [...new Set([...changed.filter((c) => SOURCE.test(c)), ...listing.slice(0, MAX_FILES)])] : listing;
  // Deleted files are gone from disk but can still be imported.
  const r = await resolver(root, [...new Set([...listing, ...changed])]);
  const changedSet = new Set(changed);

  const edges: DepEdge[] = [];
  const dependentHits = new Map<string, string[]>();
  const importers = new Map<string, string[]>();
  for (let i = 0; i < sources.length; i += 64) {
    await Promise.all(
      sources.slice(i, i + 64).map(async (from) => {
        const targets = new Set((await specifiers(root, from)).flatMap((s) => resolve(r, from, s)));
        targets.delete(from);
        for (const to of targets) {
          if (!changedSet.has(to)) continue;
          importers.set(to, [...(importers.get(to) ?? []), from]);
          if (changedSet.has(from)) edges.push({ from, to });
          else dependentHits.set(from, [...(dependentHits.get(from) ?? []), to]);
        }
      }),
    );
  }

  // Keep the dependents that touch the most changed files, a few per target.
  const perTarget = new Map<string, number>();
  const dependents: string[] = [];
  for (const [from, tos] of [...dependentHits].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (dependents.length >= MAX_DEPENDENTS) break;
    const room = tos.filter((t) => (perTarget.get(t) ?? 0) < MAX_PER_TARGET);
    if (!room.length) continue;
    dependents.push(from);
    for (const t of tos) {
      perTarget.set(t, (perTarget.get(t) ?? 0) + 1);
      edges.push({ from, to: t });
    }
  }
  return { edges, dependents: dependents.sort(), importers };
}
