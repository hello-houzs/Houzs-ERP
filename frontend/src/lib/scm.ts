// Shared helpers for the ported 2990's SCM (furniture supply chain) pages.
// All SCM endpoints live under /api/scm/* (the Hono routes ported from 2990's,
// which talk to the `scm` Postgres schema). Money in the SCM layer is stored as
// integer *_centi (sen, 1/100 of a currency unit), matching 2990's convention.

export const SCM = "/api/scm";

const CURRENCY_SYMBOL: Record<string, string> = {
  MYR: "RM",
  SGD: "S$",
  USD: "US$",
  RMB: "¥",
};

/** Format an integer *_centi value into a display string, e.g. 123456 → "RM 1,234.56". */
export function fmtCenti(centi: number | null | undefined, currency = "MYR"): string {
  const n = (centi ?? 0) / 100;
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const num = n.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sym}${num}`;
}

/** SCM document/master statuses share a small colour vocabulary. Returns
 *  Tailwind classes for a status pill (semantic tokens from tailwind.config). */
export function scmStatusClasses(status: string | null | undefined): string {
  switch ((status ?? "").toUpperCase()) {
    case "ACTIVE":
    case "POSTED":
    case "RECEIVED":
    case "COMPLETED":
    case "DELIVERED":
      return "bg-synced/15 text-synced border-synced/30";
    case "BLOCKED":
    case "CANCELLED":
      return "bg-err/10 text-err border-err/30";
    case "SUBMITTED":
    case "PARTIALLY_RECEIVED":
    case "PARTIALLY_PAID":
    case "DRAFT":
      // `warning` token only defines bg/text sub-keys (no DEFAULT), so
      // text-warning / bg-warning/15 don't resolve — use the explicit names.
      return "bg-warning-bg text-warning-text border-warning-text/30";
    default:
      return "bg-surface-dim text-ink-muted border-border";
  }
}
