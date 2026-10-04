import type { Live } from "../lib/live.ts";
import { Check } from "../ui/icons.tsx";

export function LiveStatus({ live }: { live: Live }) {
  const [name, status] = live.agent?.split(":") ?? [];
  const working = status === "working";
  const label = !live.connected ? "Reconnecting…" : name ? `${name} ${status === "done" || status === "idle" ? "idle" : status === "blocked" ? "needs you" : status}` : "Live";
  const title = !live.connected
    ? "Lost the connection to the graphdiff server. It reconnects by itself; if it doesn't, press prefix+g in herdr."
    : working
      ? "The agent is still working, so more changes may arrive. The page updates by itself."
      : "Updates by itself as files change";
  return (
    <span class={`live ${live.connected ? "on" : "off"} ${working ? "working" : ""} ${status === "blocked" ? "blocked" : ""}`} title={title}>
      <span class="dot" />
      {label}
    </span>
  );
}

export function Progress({ done, total, onNext }: { done: number; total: number; onNext: () => void }) {
  const all = done === total;
  return (
    <div class={`progress ${all ? "all" : ""}`}>
      <div class="bar" title={`${done} of ${total} reviewed`} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${(done / total) * 100}%` }} />
      </div>
      {all ? (
        <span class="progress-label">
          <Check /> All {total} reviewed
        </span>
      ) : (
        <>
          <span class="progress-label">
            <b>{total - done}</b> left
            <span class="muted">of {total}</span>
          </span>
          <button class="btn small" onClick={onNext} title="Next file to review (n)">
            Next
          </button>
        </>
      )}
    </div>
  );
}
