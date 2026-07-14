// ----------------------------------------------------------------------------
// dates — Malaysia-calendar date helpers for form defaults.
//
// `new Date().toISOString().slice(0, 10)` is the UTC calendar date; Malaysia
// is UTC+8, so before 08:00 MYT it returns YESTERDAY — every "today" form
// default (doc dates, payment dates, filter ranges) was a day off each
// morning. Mirror of `todayMY()` (SoFromProducts.tsx): shift the clock +8h,
// then read the UTC date — that IS the Malaysian calendar date, regardless of
// the browser's own timezone.
// ----------------------------------------------------------------------------

/** Today's calendar date in Malaysia (UTC+8) as `YYYY-MM-DD`.
 *  Optional `offsetDays` shifts the result (e.g. `todayMyt(-365)` = a year ago). */
export const todayMyt = (offsetDays = 0): string =>
  new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000)
    .toISOString().slice(0, 10);

/** True when the given instant (UTC ISO string) falls on the current Malaysian
 *  calendar day — drives the same-day payment EDIT affordance. Uses the same
 *  +8h shift as `todayMyt()` so both sides agree regardless of the browser zone. */
export const isCreatedTodayMyt = (createdAt: string | null | undefined): boolean => {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10) === todayMyt();
};
