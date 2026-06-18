/* ─────────────────────────── Monthly doc numbers ───────────────────────────
   Next `<PREFIX>-YYMM-NNN` from the rows that already exist in the month.

   MUST be max(suffix)+1, NEVER count+1. Deleting a mid-month row (create
   rollbacks, data cleanups) leaves a gap, so count+1 eventually re-mints a
   surviving number and the insert hits the primary key — permanently, since
   a failed insert doesn't change the count. This took down POS order
   creation on 2026-06-12 after the go-live cleanup deleted SO-2606-002..007:
   count=7 kept re-minting the surviving SO-2606-008 forever.

   max+1 self-heals: a concurrent-create race still loses one insert to the
   pkey, but the next attempt reads the new max and moves past it.

   Pure function — callers fetch the month's doc numbers themselves. */
export function nextMonthlyDocNo(monthPrefix: string, existing: string[]): string {
  const head = `${monthPrefix}-`;
  let max = 0;
  for (const docNo of existing) {
    if (!docNo.startsWith(head)) continue;
    const tail = docNo.slice(head.length);
    if (!/^\d+$/.test(tail)) continue;
    const n = parseInt(tail, 10);
    if (n > max) max = n;
  }
  return `${head}${String(max + 1).padStart(3, '0')}`;
}
