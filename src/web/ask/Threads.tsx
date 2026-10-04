import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Anchor, Thread } from "../../server/agents/ask.ts";
import { renderMarkdown } from "./md.ts";

export type Target = "inline" | "agent";

export function anchorLabel(a: Anchor | null): string {
  if (!a) return "this file";
  const r = a.start === a.end ? `line ${a.start}` : `lines ${a.start}–${a.end}`;
  return a.side === "old" ? `removed ${r}` : r;
}

interface CardProps {
  thread: Thread;
  agent: string | null;
  /** Shown when the thread can't sit next to its lines any more (the file moved on). */
  showCode?: boolean;
  onReply: (text: string, target: Target) => Promise<void>;
  onDelete: () => void;
}

export function ThreadCard({ thread, agent, showCode, onReply, onDelete }: CardProps) {
  const busy = thread.messages.some((m) => m.status === "streaming" && m.role === "answer");
  return (
    <div class="thread" onClick={(e) => e.stopPropagation()}>
      <div class="thread-head">
        <span class="thread-anchor">{anchorLabel(thread.anchor)}</span>
        <div class="spacer" />
        <button class="icon-btn" title="Remove this question" aria-label="Remove this question" onClick={onDelete}>
          ×
        </button>
      </div>
      {showCode && thread.code && <pre class="thread-code">{thread.code.split("\n").slice(0, 6).join("\n")}</pre>}
      {thread.messages.map((m, i) =>
        m.role === "you" ? (
          <div key={i} class="msg you">
            <span class="who">You</span>
            {m.text}
          </div>
        ) : m.role === "sent" ? (
          <div key={i} class={`msg sent ${m.status}`}>
            → {m.by}: {m.text || "sending…"}
          </div>
        ) : (
          <div key={i} class={`msg answer ${m.status}`}>
            <span class="who">{m.by ?? "answer"}</span>
            {m.text ? <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} /> : <span class="thinking">Thinking…</span>}
            {m.status === "streaming" && m.text && <span class="caret" />}
          </div>
        ),
      )}
      {!busy && <Composer compact label="Follow up" agent={agent} onAsk={onReply} />}
    </div>
  );
}

interface ComposerProps {
  label: string;
  agent: string | null;
  compact?: boolean;
  focusKey?: unknown;
  onAsk: (text: string, target: Target) => Promise<void>;
  onCancel?: () => void;
}

/** Enter asks inline, ⌘/Ctrl+Enter sends to the pane's agent, Shift+Enter is a newline. */
export function Composer({ label, agent, compact, focusKey, onAsk, onCancel }: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Layout effect: focus before the next keypress can land on the page instead.
  useLayoutEffect(() => {
    if (focusKey !== undefined) ref.current?.focus();
  }, [focusKey]);

  const submit = async (target: Target) => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await onAsk(text, target);
      setText("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div class={`composer ${compact ? "compact" : ""}`}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={compact ? "Follow up…" : `Ask about ${label}…`}
        onInput={(e) => {
          const el = e.currentTarget;
          setText(el.value);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.currentTarget.blur();
            onCancel?.();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit(e.metaKey || e.ctrlKey ? "agent" : "inline");
          }
        }}
      />
      <div class="composer-actions">
        <button class="btn small primary" disabled={!text.trim() || sending} onClick={() => submit("inline")} title="Ask a read-only side agent; the answer shows here (Enter)">
          Ask <kbd>↵</kbd>
        </button>
        <button class="btn small" disabled={!text.trim() || sending || !agent} onClick={() => submit("agent")} title={agent ? `Send to the ${agent} agent in your herdr pane (⌘↵)` : "No agent in the herdr pane"}>
          Send to {agent ?? "agent"} <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}
