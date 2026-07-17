import { paginateAll } from './paginate-all';

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

/* ────────────────── Reading the month (max+1's only input) ──────────────────
   `nextMonthlyDocNo` is exactly as good as the list it is handed, and the
   obvious way to fetch that list is silently wrong:

     await sb.from('sales_invoices').select('invoice_number')
       .like('invoice_number', `${p}SI-${yymm}-%`);        // ← ≤1000 rows, no error

   PostgREST caps a response at 1000 rows and drops the rest WITHOUT an error
   (see lib/paginate-all.ts — `.limit(5000)` does not lift the ceiling either).
   Past the 1000th document in one YYMM the scan comes back truncated, the max
   is stale, and the mint re-issues a number that is already live → 23505.
   Unlike the concurrent-create race below, this does NOT self-heal: every one
   of insertWithDocNoRetry's attempts re-reads the same truncated set and
   re-mints the same dead number, so creation stays 500 for the REST OF THE
   MONTH. Same failure as the 2026-06-12 POS outage above, but deterministic
   rather than a race — it arrives on a schedule, not on a coincidence.

   `.order(col, { ascending: false }).limit(1)` reads fewer rows and is WRONG
   here: the suffix is padStart(3)-padded, so the 1000th document is
   `SI-2607-1000` and a lexical sort ranks `SI-2607-999` above it. That string
   cliff lands on the very same document as the row cap it was meant to dodge,
   so it trades a silent truncation for a silent mis-sort at identical volume.
   (The JE minters — routes/accounting.ts, lib/post-si-revenue.ts — do use that
   shape and are fine ONLY because they pad to 4, moving their break to 10k/mo.)
   Paging the month and taking a NUMERIC max is padding-agnostic: it stays
   correct across 999 → 1000 and any later width change.

   `monthPrefix` feeds BOTH the LIKE and nextMonthlyDocNo, so the two can no
   longer drift apart — the per-company prefix contract in lib/companyScope.ts
   (HOUZS bare `SI-2607-001`, others `2990-SI-2607-001`) now holds by
   construction rather than by remembering to paste the same template twice. */
export async function fetchMonthlyDocNos(
  sb: any,
  table: string,
  col: string,
  monthPrefix: string,
): Promise<string[]> {
  // `.order(col)` is what makes the paging stable: with no sort key PostgREST
  // may hand the same row back in two `.range()` windows and silently drop
  // another. `col` carries the UNIQUE doc-no index, so the order is total.
  const { data } = await paginateAll<Record<string, unknown>>((from, to) =>
    sb.from(table).select(col).like(col, `${monthPrefix}-%`).order(col).range(from, to),
  );
  // Exactly one column is selected, so the row's single string value IS the doc
  // number whichever key the driver named it (trips read `trip_no`/`tripNo`).
  // A fetch error still yields [] — identical to the old `data ?? []`: the
  // insert collides and insertWithDocNoRetry handles it exactly as it does
  // today. The ONLY behaviour change here is that the set is no longer cut off.
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => Object.values(row).find((v) => typeof v === 'string'))
    .filter((v): v is string => typeof v === 'string');
}

/** Fetch the month uncapped + max+1 — the whole mint for a single-create
    minter. `monthPrefix` is the doc number WITHOUT the trailing `-NNN`, e.g.
    `${companyDocPrefix(c)}SI-${yymm}`. */
export async function mintMonthlyDocNo(
  sb: any,
  table: string,
  col: string,
  monthPrefix: string,
): Promise<string> {
  return nextMonthlyDocNo(monthPrefix, await fetchMonthlyDocNos(sb, table, col, monthPrefix));
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
