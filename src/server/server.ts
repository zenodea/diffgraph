import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { loadConfig, stateDir } from "./env.ts";
import { HttpError, match, readBody, route, sendJson } from "./http.ts";
import { liveConnections } from "./live.ts";
import { registerRepo, repoOr404 } from "./repos.ts";
import "./routes.ts";

const root = join(import.meta.dirname, "../..");
const webDir = join(root, "dist/web");
export const serverFile = join(stateDir, "server.json");
const IDLE_MS = 30 * 60_000;

export interface ServerInfo {
  port: number;
  pid: number;
  token: string;
}

/** Stable across restarts, so open tabs keep working after the server comes back. */
function loadToken(): string {
  const file = join(stateDir, "token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const token = randomBytes(18).toString("base64url");
    writeFileSync(file, token, { mode: 0o600 });
    return token;
  }
}

let lastActivity = Date.now();

const types: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
};

route("GET", "/api/health", () => ({ ok: true, pid: process.pid }));

route("POST", "/api/register", async ({ body }) => {
  const { root, paneId, agent } = await body();
  if (typeof root !== "string") throw new HttpError(400, "root required");
  return registerRepo(root, paneId ?? null, agent ?? null);
});

route("GET", "/api/repos/:id", ({ params }) => repoOr404(params.id));

route("POST", "/api/shutdown", ({ res }) => {
  res.on("finish", () => shutdown());
  return { ok: true };
});

function shutdown(): never {
  try {
    const info = JSON.parse(readFileSync(serverFile, "utf8")) as ServerInfo;
    if (info.pid === process.pid) rmSync(serverFile);
  } catch {}
  process.exit(0);
}

export async function startServer(): Promise<ServerInfo> {
  const token = loadToken();
  const config = loadConfig();

  const server = createServer(async (req, res) => {
    lastActivity = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // DNS rebinding: only answer to loopback names.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) {
        throw new HttpError(403, "bad host");
      }
      if (url.pathname.startsWith("/api/")) {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "bad origin");
        const given = req.headers["x-graphdiff-token"] ?? url.searchParams.get("t");
        if (url.pathname !== "/api/health" && given !== token) throw new HttpError(401, "bad token");
        const m = match(req.method ?? "GET", url.pathname);
        if (!m) throw new HttpError(404, "not found");
        const result = await m.handler({ req, res, url, params: m.params, body: () => readBody(req) });
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result ?? { ok: true });
        return;
      }
      serveStatic(url.pathname, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  });

  const port = await listen(server, config.port);
  const info: ServerInfo = { port, pid: process.pid, token };
  writeFileSync(serverFile, JSON.stringify(info));
  console.log(`graphdiff listening on http://127.0.0.1:${port}`);

  setInterval(() => {
    if (liveConnections.size === 0 && Date.now() - lastActivity > IDLE_MS) shutdown();
  }, 60_000).unref();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return info;
}

/** Prefers the configured port so bookmarks survive restarts; falls back to any free one. */
function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE" || port === 0) return reject(e);
      server.listen(0, "127.0.0.1");
    };
    server.on("error", onError);
    server.on("listening", () => {
      server.off("error", onError);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
    server.listen(port, "127.0.0.1");
  });
}

function serveStatic(pathname: string, res: import("node:http").ServerResponse) {
  if (pathname === "/" || pathname.startsWith("/r/")) {
    res.writeHead(200, { "content-type": types[".html"], "cache-control": "no-store" });
    res.end(readFileSync(join(root, "src/web/index.html")));
    return;
  }
  if (!pathname.startsWith("/assets/")) throw new HttpError(404, "not found");
  const rel = normalize(pathname.slice("/assets/".length));
  if (rel.startsWith("..")) throw new HttpError(404, "not found");
  let data: Buffer;
  try {
    data = readFileSync(join(webDir, rel));
  } catch {
    throw new HttpError(404, "not found (did you run npm run build?)");
  }
  res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(data);
}
