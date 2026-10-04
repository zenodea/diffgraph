import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, repoId, type Repo } from "./api.ts";
import "./styles.css";

function App() {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Repo>(`/api/repos/${repoId}`).then(setRepo, (e) => setError(e.message));
  }, []);

  if (error) return <Notice title="Can't open this repo" body={error} />;
  if (!repo) return <Notice title="Loading…" />;

  document.title = `${repo.name} · graphdiff`;
  return (
    <div class="app">
      <header class="topbar">
        <div class="repo">
          <span class="repo-name">{repo.name}</span>
        </div>
      </header>
      <main class="empty">Nothing here yet.</main>
    </div>
  );
}

export function Notice({ title, body }: { title: string; body?: string }) {
  return (
    <div class="notice">
      <h1>{title}</h1>
      {body && <p>{body}</p>}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
