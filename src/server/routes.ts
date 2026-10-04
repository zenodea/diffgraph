// Every HTTP endpoint the page uses. Logic lives in the modules imported here.
import { deleteThread, getThreads, reply, startThread } from "./agents/ask.ts";
import { getChanges, parseScope } from "./git/changes.ts";
import { dependencies } from "./deps/deps.ts";
import { fileDiff, sendImage } from "./git/fileDiff.ts";
import { loadConfig } from "./core/env.ts";
import { allFiles, repoState } from "./git/git.ts";
import { HttpError, route } from "./core/http.ts";
import { subscribe } from "./core/live.ts";
import { repoOr404 } from "./core/repos.ts";
import { setReviewed, sinceReview, withReviews } from "./review/review.ts";
import { getSummaries } from "./agents/summaries.ts";
import { whyFor } from "./agents/why.ts";

route("GET", "/api/repos/:id/changes", async ({ params, url }) => {
  const repo = repoOr404(params.id);
  const changes = await getChanges(repo, parseScope(url.searchParams.get("scope")));
  return { ...changes, files: await withReviews(repo, changes, changes.files) };
});

route("GET", "/api/repos/:id/files", async ({ params }) => ({ paths: await allFiles(repoOr404(params.id).root) }));

route("GET", "/api/repos/:id/diff", async ({ params, url }) => {
  const repo = repoOr404(params.id);
  const changes = await getChanges(repo, parseScope(url.searchParams.get("scope")));
  return fileDiff(repo, changes, url.searchParams.get("path") ?? "", url.searchParams.get("full") === "1");
});

route("GET", "/api/repos/:id/image", ({ params, url, res }) =>
  sendImage(repoOr404(params.id), url.searchParams.get("path") ?? "", url.searchParams.get("rev"), res),
);

route("POST", "/api/repos/:id/review", async ({ params, body }) => {
  const repo = repoOr404(params.id);
  const { files, reviewed } = await body();
  if (!Array.isArray(files) || typeof reviewed !== "boolean") throw new HttpError(400, "files and reviewed required");
  await setReviewed(repo, await repoState(repo.root, loadConfig().base), files, reviewed);
  return { ok: true };
});

route("GET", "/api/repos/:id/since-review", async ({ params, url }) => {
  const repo = repoOr404(params.id);
  const changes = await getChanges(repo, parseScope(url.searchParams.get("scope")));
  return sinceReview(repo, changes, url.searchParams.get("path") ?? "");
});

route("GET", "/api/repos/:id/events", ({ params, res }) => subscribe(repoOr404(params.id), res));

route("GET", "/api/repos/:id/why", async ({ params, url }) => {
  const repo = repoOr404(params.id);
  const changes = await getChanges(repo, parseScope(url.searchParams.get("scope")));
  return { entries: await whyFor(repo, changes.from, url.searchParams.get("path") ?? "") };
});

route("GET", "/api/repos/:id/threads", ({ params }) => ({ threads: getThreads(repoOr404(params.id)) }));

route("POST", "/api/repos/:id/threads", async ({ params, body }) => {
  const repo = repoOr404(params.id);
  const { path, anchor, code, question, target, scope } = await body();
  if (typeof path !== "string" || typeof question !== "string") throw new HttpError(400, "path and question required");
  const changes = await getChanges(repo, parseScope(scope ?? null));
  return startThread(repo, changes, { path, anchor: anchor ?? null, code: code ?? "", question, target: target === "agent" ? "agent" : "inline" });
});

route("POST", "/api/repos/:id/threads/:tid", async ({ params, body }) => {
  const repo = repoOr404(params.id);
  const { question, target, scope } = await body();
  const changes = await getChanges(repo, parseScope(scope ?? null));
  return reply(repo, changes, params.tid, { question: String(question ?? ""), target: target === "agent" ? "agent" : "inline" });
});

route("DELETE", "/api/repos/:id/threads/:tid", ({ params }) => {
  deleteThread(repoOr404(params.id), params.tid);
  return { ok: true };
});

route("GET", "/api/repos/:id/deps", async ({ params, url }) => {
  const repo = repoOr404(params.id);
  const changes = await getChanges(repo, parseScope(url.searchParams.get("scope")));
  return dependencies(repo.root, changes.files.map((f) => f.path));
});

route("POST", "/api/repos/:id/summaries", async ({ params, body }) => {
  const repo = repoOr404(params.id);
  const { scope, folders, generate } = await body();
  if (!Array.isArray(folders)) throw new HttpError(400, "folders required");
  const changes = await getChanges(repo, parseScope(scope ?? null));
  return { summaries: getSummaries(repo, changes, folders.map(String), Array.isArray(generate) ? generate.map(String) : []) };
});
