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

export function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  // Accept yyyy-mm-dd or full ISO. Render as DD/MM/YYYY (Malaysian convention).
  const iso = d.slice(0, 10);
  const parts = iso.split("-");
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return iso;
}

// DD/MM/YYYY HH:mm. Used where time-of-day matters (Logistics schedule:
// setup_start_at / dismantle_end_at, etc.). Treats stored values as
// local-ish — the user enters them in local time and we display the
// same wall-clock string back without timezone conversion.
export function formatDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  const datePart = formatDate(d);
  if (datePart === "—") return "—";
  const time = d.slice(11, 16);
  if (!/^\d{2}:\d{2}$/.test(time)) return datePart;
  return `${datePart} ${time}`;
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
  // Past one week — fall back to the absolute date in DD/MM/YYYY,
  // matching the rest of the SPA's date format.
  return formatDate(date.toISOString());
}

export function isExpired(d: string | null | undefined): boolean {
  if (!d) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(d) < today;
}

export function isExpiringSoon(d: string | null | undefined, days = 3): boolean {
  if (!d) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() + days);
  const date = new Date(d);
  return date >= today && date <= cutoff;
}
