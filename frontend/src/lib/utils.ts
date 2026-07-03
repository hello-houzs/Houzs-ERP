export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function formatCurrency(n: number | null | undefined, opts?: { compact?: boolean }): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `RM ${(n / 1_000_000).toFixed(2)}M`;
    if (Math.abs(n) >= 1_000) return `RM ${(n / 1_000).toFixed(1)}K`;
  }
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return n.toLocaleString("en-MY");
}

// ── Time zone ────────────────────────────────────────────────
//
// All audit timestamps in the DB are written via SQLite `datetime('now')`,
// which returns UTC strings like `2026-05-28 17:30:00`. The team operates
// in Malaysia / Singapore time (GMT+8) and everything that surfaces a
// real-world moment must be displayed in that zone, not in whatever
// timezone the user's browser happens to be set to.
//
// User-entered scheduling fields (setup_start_at, payment_date, …) take
// a different shape — `YYYY-MM-DDTHH:MM`, sourced from `<input
// type="datetime-local">` — and are stored as wall-clock strings with no
// timezone implied. Those must NOT be converted; we display whatever
// the user typed.
//
// The two cases are distinguishable by the string itself (see the
// helpers below) so a single formatter picks the right branch.

export const APP_TZ = "Asia/Kuala_Lumpur";

function isWallClockDateTime(s: string): boolean {
  // Format produced by datetime-local input. 16 chars, T separator,
  // no seconds → we treat this as wall-clock-as-typed.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);
}

function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Parse a timestamp string into a Date, treating bare SQLite "YYYY-MM-DD HH:MM:SS"
 * values as UTC.
 *
 * SQLite's `datetime('now')` returns an unzoned UTC string like
 *   2026-04-08 11:30:00
 * JavaScript's `new Date()` parses unzoned strings as LOCAL time, which
 * silently shifts the value by the user's timezone offset (e.g. 8 hours
 * for GMT+8) and produces stale "Xh ago" labels for rows that were just
 * created. We normalize by appending "Z" so the parser treats it as UTC.
 *
 * Already-zoned ISO strings (containing T/Z/+/-) are passed through as-is.
 */
export function parseDate(d: string | null | undefined): Date | null {
  if (!d) return null;
  let s = d;
  // Bare SQLite timestamp: "YYYY-MM-DD HH:MM:SS[.fff]" → tag as UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }
  const date = new Date(s);
  return isNaN(date.getTime()) ? null : date;
}

// Memoised Intl formatters — these are expensive to construct and we
// call them on every row in long lists. House style is numeric
// DD/MM/YYYY (owner requirement — no "Jun"/"Jul" month names anywhere on
// the desktop app).
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const timestampFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatViaIntl(d: string, fmt: Intl.DateTimeFormat): string {
  const date = parseDate(d);
  if (!date) return "—";
  // `en-GB` gives "28/05/2026, 17:30" — strip the comma to match the
  // app's house style of "DD/MM/YYYY HH:mm".
  return fmt.format(date).replace(",", "");
}

export function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  // Date-only fields don't carry a timezone — display verbatim as DD/MM/YYYY.
  if (isDateOnly(d)) {
    const [y, m, day] = d.split("-");
    return `${day}/${m}/${y}`;
  }
  // Wall-clock scheduling fields — slice the date portion, no conversion.
  if (isWallClockDateTime(d)) {
    return formatDate(d.slice(0, 10));
  }
  // Everything else is an audit / system timestamp stored as UTC. Show
  // the date in GMT+8 (so a late-night UTC creation rolls over to
  // tomorrow correctly).
  return formatViaIntl(d, dateFmt);
}

/**
 * DD/MM/YYYY HH:mm. Picks the right branch based on the input shape:
 *  - Wall-clock `YYYY-MM-DDTHH:MM` → display as-is (no conversion).
 *  - Date-only → date + 00:00.
 *  - Everything else → parse as UTC, render in GMT+8.
 */
export function formatDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  if (isWallClockDateTime(d)) {
    return `${formatDate(d.slice(0, 10))} ${d.slice(11, 16)}`;
  }
  if (isDateOnly(d)) {
    return `${formatDate(d)} 00:00`;
  }
  return formatViaIntl(d, dateTimeFmt);
}

/**
 * DD/MM/YYYY HH:mm:ss in GMT+8. Use this for audit timestamps where
 * the full second is meaningful (activity log, attachment uploaded_at,
 * etc.). For scheduling fields prefer formatDateTime.
 */
export function formatTimestamp(d: string | null | undefined): string {
  if (!d) return "—";
  if (isWallClockDateTime(d)) {
    return `${formatDate(d.slice(0, 10))} ${d.slice(11, 16)}:00`;
  }
  if (isDateOnly(d)) {
    return `${formatDate(d)} 00:00:00`;
  }
  return formatViaIntl(d, timestampFmt);
}

export function relativeTime(d: string | null | undefined): string {
  if (!d) return "—";
  const date = parseDate(d);
  if (!date) return "—";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  // Negative diffs (clock skew) → treat as "just now" instead of "in 5s"
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  // Past one week — fall back to the absolute date in DD/MM/YYYY (GMT+8),
  // matching the rest of the SPA's date format.
  return formatViaIntl(date.toISOString(), dateFmt);
}

/**
 * "Today" in GMT+8, returned as YYYY-MM-DD so callers can compare to
 * date-only DB columns without timezone surprises.
 */
export function todayInAppTz(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

export function isExpired(d: string | null | undefined): boolean {
  if (!d) return false;
  const today = todayInAppTz();
  // Date-only / wall-clock fields compare directly as strings.
  const datePart = isDateOnly(d) || isWallClockDateTime(d) ? d.slice(0, 10) : null;
  if (datePart) return datePart < today;
  // Audit timestamp — compare its GMT+8 calendar date.
  const date = parseDate(d);
  if (!date) return false;
  const inTz = formatViaIntl(d, dateFmt); // DD/MM/YYYY
  if (inTz === "—") return false;
  // Convert DD/MM/YYYY → YYYY-MM-DD for lexicographic compare.
  const [dd, mm, yyyy] = inTz.split("/");
  return `${yyyy}-${mm}-${dd}` < today;
}

export function isExpiringSoon(d: string | null | undefined, days = 3): boolean {
  if (!d) return false;
  const today = todayInAppTz();
  // Compute cutoff in GMT+8 by anchoring midnight at this calendar date.
  const cutoff = new Date(`${today}T00:00:00+08:00`);
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = formatViaIntl(cutoff.toISOString(), dateFmt);
  const [cd, cm, cy] = cutoffStr.split("/");
  const cutoffIso = `${cy}-${cm}-${cd}`;

  const datePart =
    isDateOnly(d) || isWallClockDateTime(d) ? d.slice(0, 10) : null;
  if (datePart) return datePart >= today && datePart <= cutoffIso;

  const inTz = formatViaIntl(d, dateFmt);
  if (inTz === "—") return false;
  const [dd, mm, yyyy] = inTz.split("/");
  const iso = `${yyyy}-${mm}-${dd}`;
  return iso >= today && iso <= cutoffIso;
}
