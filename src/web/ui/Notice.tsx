export function Notice({ title, body }: { title: string; body?: string }) {
  return (
    <div class="notice">
      <h1>{title}</h1>
      {body && <p>{body}</p>}
    </div>
  );
}
