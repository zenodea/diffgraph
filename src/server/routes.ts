// Every HTTP endpoint the page uses. Logic lives in the modules imported here.
import { getChanges, parseScope } from "./changes.ts";
import { fileDiff, sendImage } from "./fileDiff.ts";
import { loadConfig } from "./env.ts";
import { allFiles, repoState } from "./git.ts";
import { HttpError, route } from "./http.ts";
import { repoOr404 } from "./repos.ts";
import { setReviewed, sinceReview, withReviews } from "./review.ts";

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
