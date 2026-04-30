import { useEffect, useRef, useState } from "react";
import { Gift, Search, X } from "lucide-react";
import { api } from "../api/client";
import { useToast } from "../hooks/useToast";
import { useNotifications } from "../hooks/useNotifications";
import { Avatar } from "./Avatar";
import { cn } from "../lib/utils";

/**
 * SendPointsButton — peer-to-peer Houzs Points gift popover.
 *
 * The trigger renders inline (typically at the right edge of a Team
 * row, message author chip, or the gamification header). Clicking
 * opens a small popover with:
 *   • the user's remaining gifting balance for the month
 *   • amount input (default 10, clamped to admin min/max)
 *   • optional recipient search (omitted when `prefill` is set)
 *   • optional message
 *   • Send button
 *
 * On success it refreshes useNotifications so the topbar chip updates.
 */

interface Recipient {
  id: number;
  name: string;
  email: string;
  department_name: string | null;
  profile_pic_r2_key?: string | null;
}

interface Props {
  /** Pre-selected recipient — hides the picker when set. */
  prefill?: { id: number; name: string };
  /** Override the default trigger label. */
  label?: string;
  /** Render as compact icon-only chip; otherwise label + icon. */
  compact?: boolean;
  className?: string;
}

export function SendPointsButton({ prefill, label, compact, className }: Props) {
  const toast = useToast();
  const { giftingBalance, reload } = useNotifications();

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<string>("10");
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [picked, setPicked] = useState<Recipient | null>(
    prefill ? { id: prefill.id, name: prefill.name, email: "", department_name: null } : null,
  );
  const [busy, setBusy] = useState(false);

  const popRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Lazy-load recipients when the picker is visible and there's no prefill.
  useEffect(() => {
    if (!open || prefill) return;
    let cancelled = false;
    api
      .get<{ rows: Recipient[] }>(
        `/api/gamify/recipients${search ? `?q=${encodeURIComponent(search)}` : ""}`,
      )
      .then((r) => {
        if (!cancelled) setRecipients(r.rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, prefill, search]);

  async function handleSend() {
    if (!picked) {
      toast.error("Pick a recipient first");
      return;
    }
    const amt = parseInt(amount, 10);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    if (amt > giftingBalance) {
      toast.error("That's more than your gifting balance left this month");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/gamify/gift", {
        to_user_id: picked.id,
        amount: amt,
        note: note.trim() || undefined,
      });
      toast.success(`Sent ${amt} pts to ${picked.name}`);
      setOpen(false);
      setNote("");
      setAmount("10");
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("relative inline-flex", className)} ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink transition-colors hover:border-accent/40 hover:text-accent",
          compact && "px-1.5",
        )}
        title="Send Houzs Points"
      >
        <Gift size={13} className="text-accent" />
        {!compact && (label || "Send Points")}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-2 w-[300px] rounded-lg border border-border bg-surface p-3 shadow-slab animate-rise"
          role="dialog"
          aria-label="Send Houzs Points"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="font-display text-[14px] font-extrabold text-ink">
              Send Houzs Points
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-ink-muted hover:text-ink"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>

          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="text-ink-muted">Gifting balance</span>
            <span className="font-mono text-[12px] font-semibold text-accent">
              {giftingBalance} pts
            </span>
          </div>

          {!prefill && (
            <div className="mb-2">
              <div className="relative">
                <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search teammate"
                  className="w-full rounded-md border border-border bg-paper py-1.5 pl-7 pr-2 text-[12px]"
                />
              </div>
              <div className="thin-scroll mt-1 max-h-32 overflow-y-auto rounded-md border border-border bg-bg/40">
                {recipients.length === 0 && (
                  <div className="px-2 py-2 text-[11px] text-ink-muted">No matches</div>
                )}
                {recipients.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    onClick={() => setPicked(r)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent-soft/50",
                      picked?.id === r.id && "bg-accent-soft/60",
                    )}
                  >
                    <Avatar
                      userId={r.id}
                      hasImage={r.profile_pic_r2_key}
                      name={r.name}
                      email={r.email}
                      size={22}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">
                      {r.name}
                    </span>
                    {r.department_name && (
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-brand text-ink-muted">
                        {r.department_name}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {picked && (
            <div className="mb-2 rounded-md border border-accent/30 bg-accent-soft/30 px-2 py-1.5 text-[11px]">
              To <span className="font-semibold text-ink">{picked.name}</span>
            </div>
          )}

          <label className="mb-1 block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Amount</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={giftingBalance}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[13px] font-semibold"
            />
          </label>

          <label className="mb-3 block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 280))}
              rows={2}
              placeholder="Thanks for the lift on the booth..."
              className="thin-scroll mt-0.5 w-full resize-none rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
            />
          </label>

          <button
            type="button"
            disabled={busy || !picked || giftingBalance <= 0}
            onClick={handleSend}
            className={cn(
              "flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-opacity",
              (busy || !picked || giftingBalance <= 0) && "opacity-50",
            )}
          >
            <Gift size={13} /> {busy ? "Sending…" : "Send"}
          </button>
        </div>
      )}
    </div>
  );
}
