// The page URL is /r/<repoId>?t=<token>; every API call carries the token.
const params = new URLSearchParams(location.search);
export const token = params.get("t") ?? "";
export const repoId = location.pathname.match(/^\/r\/([^/]+)/)?.[1] ?? "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "x-graphdiff-token": token, ...(init.body !== undefined && { "content-type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export interface Repo {
  id: string;
  root: string;
  name: string;
  paneId: string | null;
  agent: string | null;
}
