// Malaysia Public Holidays & School Holidays
//
// NOTE: Islamic (Hijri) and Hindu/Buddhist (lunar) holiday dates are
// approximate until gazetted. Verify against the official calendar at
// https://publicholidays.com.my and MOE school term calendar each year.
//
// Scope: federal public holidays (some states have extra, not included).
//
// School holidays apply equally to Sekolah Rendah (primary) and Sekolah
// Menengah (secondary) — MOE's Takwim Persekolahan is shared.
//
// MOE splits states into two groups by weekend day, so term breaks differ
// by ~1 day between the two groups:
//   Group A: Johor, Kedah, Kelantan, Terengganu        (weekend Fri-Sat)
//   Group B: all other states                          (weekend Sat-Sun)

import type { MalaysianState } from "./mock-data";

export interface PublicHoliday {
  date: string;        // ISO yyyy-mm-dd
  name: string;        // short name for tooltip/cell
  type: "federal" | "state";
  states?: MalaysianState[]; // only for state holidays
}

export interface SchoolHolidayRange {
  start: string;       // ISO yyyy-mm-dd (inclusive)
  end: string;         // ISO yyyy-mm-dd (inclusive)
  name: string;        // e.g. "Mid-term 1", "Year-end break"
  group?: "A" | "B";   // A = most states, B = JHR/KDH/KTN/TRG
}

// ============================================================================
// PUBLIC HOLIDAYS (federal)
// ============================================================================

export const PUBLIC_HOLIDAYS: PublicHoliday[] = [
  // --- 2025 ---
  { date: "2025-01-01", name: "New Year",            type: "federal" },
  { date: "2025-01-29", name: "Chinese New Year",    type: "federal" },
  { date: "2025-01-30", name: "CNY Day 2",           type: "federal" },
  { date: "2025-03-18", name: "Nuzul Al-Quran",      type: "federal" },
  { date: "2025-03-31", name: "Hari Raya Puasa",     type: "federal" },
  { date: "2025-04-01", name: "Hari Raya Puasa 2",   type: "federal" },
  { date: "2025-05-01", name: "Labour Day",          type: "federal" },
  { date: "2025-05-12", name: "Wesak Day",           type: "federal" },
  { date: "2025-06-02", name: "Agong's Birthday",    type: "federal" },
  { date: "2025-06-07", name: "Hari Raya Haji",      type: "federal" },
  { date: "2025-06-27", name: "Awal Muharram",       type: "federal" },
  { date: "2025-08-31", name: "Merdeka Day",         type: "federal" },
  { date: "2025-09-05", name: "Maulidur Rasul",      type: "federal" },
  { date: "2025-09-16", name: "Malaysia Day",        type: "federal" },
  { date: "2025-10-20", name: "Deepavali",           type: "federal" },
  { date: "2025-12-25", name: "Christmas",           type: "federal" },

  // --- 2026 ---
  { date: "2026-01-01", name: "New Year",            type: "federal" },
  { date: "2026-02-17", name: "Chinese New Year",    type: "federal" },
  { date: "2026-02-18", name: "CNY Day 2",           type: "federal" },
  { date: "2026-03-07", name: "Nuzul Al-Quran",      type: "federal" },
  { date: "2026-03-20", name: "Hari Raya Puasa",     type: "federal" },
  { date: "2026-03-21", name: "Hari Raya Puasa 2",   type: "federal" },
  { date: "2026-05-01", name: "Labour Day",          type: "federal" },
  { date: "2026-05-01", name: "Wesak Day",           type: "federal" },
  { date: "2026-05-27", name: "Hari Raya Haji",      type: "federal" },
  { date: "2026-06-01", name: "Agong's Birthday",    type: "federal" },
  { date: "2026-06-17", name: "Awal Muharram",       type: "federal" },
  { date: "2026-08-25", name: "Maulidur Rasul",      type: "federal" },
  { date: "2026-08-31", name: "Merdeka Day",         type: "federal" },
  { date: "2026-09-16", name: "Malaysia Day",        type: "federal" },
  { date: "2026-11-08", name: "Deepavali",           type: "federal" },
  { date: "2026-12-25", name: "Christmas",           type: "federal" },

  // --- 2027 ---
  { date: "2027-01-01", name: "New Year",            type: "federal" },
  { date: "2027-02-06", name: "Chinese New Year",    type: "federal" },
  { date: "2027-02-07", name: "CNY Day 2",           type: "federal" },
  { date: "2027-02-25", name: "Nuzul Al-Quran",      type: "federal" },
  { date: "2027-03-10", name: "Hari Raya Puasa",     type: "federal" },
  { date: "2027-03-11", name: "Hari Raya Puasa 2",   type: "federal" },
  { date: "2027-05-01", name: "Labour Day",          type: "federal" },
  { date: "2027-05-20", name: "Wesak Day",           type: "federal" },
  { date: "2027-05-17", name: "Hari Raya Haji",      type: "federal" },
  { date: "2027-06-07", name: "Agong's Birthday",    type: "federal" },
  { date: "2027-06-06", name: "Awal Muharram",       type: "federal" },
  { date: "2027-08-14", name: "Maulidur Rasul",      type: "federal" },
  { date: "2027-08-31", name: "Merdeka Day",         type: "federal" },
  { date: "2027-09-16", name: "Malaysia Day",        type: "federal" },
  { date: "2027-10-28", name: "Deepavali",           type: "federal" },
  { date: "2027-12-25", name: "Christmas",           type: "federal" },
];

// ============================================================================
// SCHOOL HOLIDAYS (Group A = most states; Group B shifts by ~1 day)
// ============================================================================

// Applies to BOTH primary (Sekolah Rendah) and secondary (Sekolah Menengah).
// Group A = JHR/KDH/KTN/TRG, Group B = all other states (majority).
export const SCHOOL_HOLIDAYS: SchoolHolidayRange[] = [
  // ===== 2025 =====
  // Group B — most states
  { start: "2025-03-22", end: "2025-03-30", name: "Term 1 Break (most states)",             group: "B" },
  { start: "2025-05-24", end: "2025-06-01", name: "Mid-Year Break (most states)",           group: "B" },
  { start: "2025-08-23", end: "2025-08-31", name: "Term 3 Break (most states)",             group: "B" },
  { start: "2025-12-13", end: "2026-01-04", name: "Year-End Break (most states)",           group: "B" },
  // Group A — JHR/KDH/KTN/TRG
  { start: "2025-03-21", end: "2025-03-29", name: "Term 1 Break (JHR/KDH/KTN/TRG)",         group: "A" },
  { start: "2025-05-23", end: "2025-05-31", name: "Mid-Year Break (JHR/KDH/KTN/TRG)",       group: "A" },
  { start: "2025-08-22", end: "2025-08-30", name: "Term 3 Break (JHR/KDH/KTN/TRG)",         group: "A" },
  { start: "2025-12-12", end: "2026-01-03", name: "Year-End Break (JHR/KDH/KTN/TRG)",       group: "A" },

  // ===== 2026 =====
  // Group B — most states
  { start: "2026-03-14", end: "2026-03-22", name: "Term 1 Break (most states)",             group: "B" },
  { start: "2026-05-23", end: "2026-05-31", name: "Mid-Year Break (most states)",           group: "B" },
  { start: "2026-08-22", end: "2026-08-30", name: "Term 3 Break (most states)",             group: "B" },
  { start: "2026-12-12", end: "2027-01-03", name: "Year-End Break (most states)",           group: "B" },
  // Group A — JHR/KDH/KTN/TRG
  { start: "2026-03-13", end: "2026-03-21", name: "Term 1 Break (JHR/KDH/KTN/TRG)",         group: "A" },
  { start: "2026-05-22", end: "2026-05-30", name: "Mid-Year Break (JHR/KDH/KTN/TRG)",       group: "A" },
  { start: "2026-08-21", end: "2026-08-29", name: "Term 3 Break (JHR/KDH/KTN/TRG)",         group: "A" },
  { start: "2026-12-11", end: "2027-01-02", name: "Year-End Break (JHR/KDH/KTN/TRG)",       group: "A" },

  // ===== 2027 =====
  // Group B — most states
  { start: "2027-03-13", end: "2027-03-21", name: "Term 1 Break (most states)",             group: "B" },
  { start: "2027-05-22", end: "2027-05-30", name: "Mid-Year Break (most states)",           group: "B" },
  { start: "2027-08-21", end: "2027-08-29", name: "Term 3 Break (most states)",             group: "B" },
  { start: "2027-12-11", end: "2028-01-02", name: "Year-End Break (most states)",           group: "B" },
  // Group A — JHR/KDH/KTN/TRG
  { start: "2027-03-12", end: "2027-03-20", name: "Term 1 Break (JHR/KDH/KTN/TRG)",         group: "A" },
  { start: "2027-05-21", end: "2027-05-29", name: "Mid-Year Break (JHR/KDH/KTN/TRG)",       group: "A" },
  { start: "2027-08-20", end: "2027-08-28", name: "Term 3 Break (JHR/KDH/KTN/TRG)",         group: "A" },
  { start: "2027-12-10", end: "2028-01-01", name: "Year-End Break (JHR/KDH/KTN/TRG)",       group: "A" },
];

// ============================================================================
// HELPERS
// ============================================================================

/** Return all public holidays intersecting a given ISO yyyy-mm-dd. */
export function getPublicHolidays(isoDate: string): PublicHoliday[] {
  return PUBLIC_HOLIDAYS.filter((h) => h.date === isoDate);
}

/** Return all school holiday ranges that contain a given ISO date. */
export function getSchoolHolidays(isoDate: string): SchoolHolidayRange[] {
  return SCHOOL_HOLIDAYS.filter(
    (r) => isoDate >= r.start && isoDate <= r.end
  );
}

/** Build a fast lookup map for a given year/month range. */
export function buildHolidayIndex(fromISO: string, toISO: string): {
  public: Record<string, PublicHoliday[]>;
  school: Record<string, SchoolHolidayRange[]>;
} {
  const pub: Record<string, PublicHoliday[]> = {};
  const sch: Record<string, SchoolHolidayRange[]> = {};

  for (const h of PUBLIC_HOLIDAYS) {
    if (h.date >= fromISO && h.date <= toISO) {
      (pub[h.date] ??= []).push(h);
    }
  }

  // For school holidays, expand ranges into individual days that fall in window
  for (const r of SCHOOL_HOLIDAYS) {
    if (r.end < fromISO || r.start > toISO) continue;
    // walk each day in the range
    const s = new Date(r.start);
    const e = new Date(r.end);
    for (let d = new Date(s); d <= e; d = new Date(d.getTime() + 86400000)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const iso = `${y}-${m}-${day}`;
      if (iso >= fromISO && iso <= toISO) {
        (sch[iso] ??= []).push(r);
      }
    }
  }

  return { public: pub, school: sch };
}
