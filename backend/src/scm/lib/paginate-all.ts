// ----------------------------------------------------------------------------
// paginateAll — page through a PostgREST query so the default 1000-row cap can
// never silently truncate a result set.
//
// PostgREST (Supabase) returns at most `max-rows` (1000) rows per response. A
// `.limit(5000)` does NOT lift that ceiling — it only sets an upper bound; the
// server still hands back ≤1000 and the rest is dropped without an error. The
// only safe way to read the full set is to page with `.range(from, to)` and
// concatenate until a page comes back shorter than the page size.
//
// Usage — pass a factory that returns a fully-built query for a given window.
// Apply all filters/ordering INSIDE the factory so every page is consistent:
//
//   const { data, error } = await paginateAll((from, to) =>
//     sb.from('mfg_products').select('id, code').eq('status', 'ACTIVE')
//       .order('code').range(from, to),
//   );
//
// The factory's query must include `.range(from, to)` (callers wire it through
// so the builder type stays inferred). Returns the same `{ data, error }` shape
// as a single PostgREST call so existing error handling is unchanged.
// ----------------------------------------------------------------------------

const PAGE = 1000;
// Absolute ceiling so a runaway view can't loop forever (50 pages = 50k rows).
const MAX_PAGES = 50;

type PageResult<T> = { data: T[] | null; error: { message: string; code?: string } | null };

/* `truncated` is true only when the MAX_PAGES ceiling was reached with a full
   final page — i.e. there was more and we stopped. It exists so the ceiling
   cannot repeat, one level up, the exact silent-truncation bug this helper was
   written to fix: a caller that must have the complete set (a CSV export, a
   PDF lookup map) can now tell the difference between "that is all of them"
   and "that is the first 50,000". Optional in the return type so the ~40
   existing `const { data, error } = await paginateAll(...)` call sites keep
   compiling untouched. */
export async function paginateAll<T = Record<string, unknown>>(
  makeQuery: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T> & { truncated: boolean }> {
  const all: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) return { data: null, error, truncated: false };
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) return { data: all, error: null, truncated: false };
  }
  // Fell out of the loop on MAX_PAGES with every page full — there is more.
  return { data: all, error: null, truncated: true };
}

// chunkIn — split a code list into ≤size batches so a `.in(col, codes)` filter
// never builds a >1000-element IN list (PostgREST will reject / the URL blows
// the length limit). Run the query per chunk and merge the rows.
//
//   const rows = await chunkIn(codes, (batch) =>
//     sb.from('...').select('...').in('item_code', batch),
//   );
//
// Each chunk is also paginated, so a single chunk that returns >1000 rows
// (e.g. many lines per code) is read in full.
export async function chunkIn<T = Record<string, unknown>>(
  codes: string[],
  makeQuery: (batch: string[], from: number, to: number) => PromiseLike<PageResult<T>>,
  size = 200,
): Promise<{ data: T[]; error: { message: string; code?: string } | null }> {
  const merged: T[] = [];
  for (let i = 0; i < codes.length; i += size) {
    const batch = codes.slice(i, i + size);
    const { data, error } = await paginateAll<T>((from, to) => makeQuery(batch, from, to));
    if (error) return { data: merged, error };
    merged.push(...(data ?? []));
  }
  return { data: merged, error: null };
}
