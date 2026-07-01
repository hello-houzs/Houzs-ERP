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

/* ─────────────────────── Mint + insert with collision retry ─────────────────
   `max+1` self-heals a deleted-gap re-mint, but two concurrent creates in the
   same YYMM still both read the same live max and mint the same suffix — the
   loser hits the UNIQUE doc-no index (Postgres 23505) and, without a retry,
   the whole create hard-fails (500). A `SELECT MAX` on the Supabase pooler can
   also miss a just-committed sibling (read-after-write lag), which surfaces the
   same way. The GRN batch path (scm/routes/grns.ts) already loops on 23505 and
   re-derives the next free suffix; this factors that exact loop out so every
   single-create minter (DO/CN/CS/CRN/DR/SI/PI/TRIP) self-heals identically.

   `mint()` re-reads the live max and returns the next free doc number (the
   existing per-route `nextNum` helper). `attempt(docNo)` runs the insert with
   that number and returns `{ data, error }` (Supabase's shape). On a 23505 the
   loop re-mints from a fresh read and retries, up to `tries` times. Any other
   error (or exhausting the retries) returns the last `{ data, error }` so the
   caller keeps its existing error handling. */
type DocNoInsertResult<T> = { data: T | null; error: { code?: string; message?: string } | null };

export async function insertWithDocNoRetry<T>(
  mint: () => Promise<string>,
  attempt: (docNo: string) => PromiseLike<DocNoInsertResult<T>>,
  tries = 8,
): Promise<DocNoInsertResult<T>> {
  let last: DocNoInsertResult<T> = { data: null, error: null };
  for (let i = 0; i < tries; i += 1) {
    const docNo = await mint();
    last = await attempt(docNo);
    if (!last.error) return last;
    if (last.error.code !== '23505') return last;
  }
  return last;
}
