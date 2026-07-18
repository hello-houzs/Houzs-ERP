// ---------------------------------------------------------------------------
// Assistant — the unified ERP chat (spec §2, owner-approved mockup 2026-07-18).
//
// One front desk: you ask in plain language, the backend routes the question to
// the specialist agents that hold the answer, and the reply is worded strictly
// from THEIR data. The routing trace under each reply shows who was consulted, so
// an answer is never an anonymous assertion.
//
// It cannot change anything — every write keeps its own screen and approval.
// ---------------------------------------------------------------------------

import { useRef, useState, useEffect } from "react";
import { Bot, Send, User } from "lucide-react";
import { api } from "../api/client";
import { PageHeader } from "../components/Layout";
import { Badge } from "../components/Badge";
import { cn } from "../lib/utils";

interface AgentRef {
  key: string;
  label: string;
}
interface Msg {
  role: "user" | "bot";
  text: string;
  agents?: AgentRef[];
  degraded?: boolean;
}

const SUGGESTIONS = [
  "Which orders are blocked and why?",
  "Who owes us the most right now?",
  "How did sales and margin do this month?",
  "What stock shortages need a purchase order?",
];

export function Assistant() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setDraft("");
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    try {
      const res = await api.post<{
        success: boolean;
        data: { answer: string; agents: AgentRef[]; degraded: boolean };
      }>("/api/assistant/chat", { message: q });
      const d = res.data;
      setMsgs((m) => [...m, { role: "bot", text: d.answer, agents: d.agents, degraded: d.degraded }]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { role: "bot", text: `Couldn't reach the assistant: ${e instanceof Error ? e.message : String(e)}`, degraded: true },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="Assistant"
        description="Ask about orders, deliveries, payments, stock or sales. It reads the agents' findings — it never changes anything."
      />

      <div className="rounded-md border border-border bg-surface shadow-stone">
        {/* stream */}
        <div className="flex min-h-[360px] flex-col gap-4 overflow-y-auto p-5" style={{ maxHeight: "58vh" }}>
          {msgs.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <Bot size={28} className="text-ink-muted" />
              <p className="text-[13px] text-ink-secondary">
                Ask a question — the assistant routes it to the right agent.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-full border border-border px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-surface-raised"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} className={cn("flex gap-2.5", m.role === "user" ? "flex-row-reverse" : "")}>
              <div
                className={cn(
                  "mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg",
                  m.role === "user" ? "bg-surface-raised text-ink-secondary" : "bg-accent/10 text-accent",
                )}
              >
                {m.role === "user" ? <User size={14} /> : <Bot size={14} />}
              </div>
              <div className={cn("max-w-[85%] rounded-xl px-3.5 py-2.5 text-[13.5px] leading-relaxed",
                m.role === "user"
                  ? "bg-accent text-white"
                  : "border border-border bg-surface-raised text-ink")}
              >
                {/* Routing trace — who answered. Only on replies that consulted someone. */}
                {m.role === "bot" && m.agents && m.agents.length > 0 && (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-border pb-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Asked</span>
                    {m.agents.map((a) => (
                      <Badge key={a.key} tone="neutral" caseless>{a.label}</Badge>
                    ))}
                  </div>
                )}
                <p className="whitespace-pre-wrap">{m.text}</p>
                {m.degraded && (
                  <p className="mt-1.5 text-[11px] text-ink-muted">
                    Answered without the AI service — the agent console has the raw findings.
                  </p>
                )}
              </div>
            </div>
          ))}

          {busy && (
            <div className="flex gap-2.5">
              <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Bot size={14} />
              </div>
              <div className="rounded-xl border border-border bg-surface-raised px-3.5 py-2.5 text-[13px] text-ink-muted">
                Asking the agents…
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* composer */}
        <div className="flex items-center gap-2 border-t border-border bg-surface-raised p-3">
          <input
            className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
            placeholder="Ask something… (e.g. why is SO-2607-041 not delivered?)"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
          />
          <button
            type="button"
            onClick={() => void send(draft)}
            disabled={busy || !draft.trim()}
            aria-label="Send"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-accent text-white disabled:opacity-40"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
