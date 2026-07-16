// ---------------------------------------------------------------------------
// Scan sample review — closes the OCR self-learning loop on the BACKGROUND
// scan path.
//
// The interactive path (operator reviews the extraction inside the New SO
// form, desktop or mobile) POSTs /scan-so/samples/:id/confirm on save, so its
// samples reach the learning pool. The BACKGROUND path (POST /scan-so/enqueue
// -> waitUntil -> DRAFT SO) does not: runScanJob stamps scan_jobs.sample_id
// (scan-so.ts) and then nothing ever confirms that sample. The operator's
// review DOES happen — they open the DRAFT and either confirm it or edit it —
// but that event was wired to nothing, so the main scan route fed the loop
// NOTHING. This module is what listens to it.
//
// The confirmation event is the DRAFT -> CONFIRMED status transition
// (PATCH /mfg-sales-orders/:docNo/status).
//
// WHY only the accepted-as-is case is captured here:
//   The DRAFT is built FROM the sample's `extracted` blob. If the operator
//   confirms it having changed nothing, `corrected = extracted` is exactly
//   true — the same object, so there is no shape to get wrong.
//   If they EDITED the draft, the honest `corrected` blob is their final
//   values in ExtractedSlip shape, which would mean reversing the lossy
//   slip -> SO mapper (itemGroup collapsed to 'others', dates nulled, rawText
//   folded into the line remark). Writing `corrected = extracted` for an
//   edited draft instead would assert "the AI read this correctly" about a
//   reading a human had just fixed — teaching the model to REPEAT the very
//   mistake, and displacing a real correction from the distill window. A
//   wrong pair is worse than no pair, so an edited draft is left alone.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';

// getSupabaseService is schema-parameterised (db:{schema:'scm'}), so the bare
// SupabaseClient type does not accept it. Same loosened alias scan-so.ts uses.
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

// Mirrors scan-so.ts's SAMPLE_* vocabulary (so_scan_samples.status is
// free-text — no check constraint, no migration).
const SAMPLE_EXTRACTED = 'EXTRACTED';
const SAMPLE_ACCEPTED = 'ACCEPTED';

/* The only audit actions that do NOT mean "a human changed the order's
   content": CREATE is the scan job's own row, UPDATE_STATUS is the very
   transition that calls us. Any OTHER action is an operator touching the
   substance of what the OCR produced. Listing the exclusions (rather than
   enumerating edit actions) is deliberate: a new mutation action added later
   counts as an edit by default, which fails toward "don't claim the AI was
   right". */
const NON_EDIT_ACTIONS = '("CREATE","UPDATE_STATUS")';

/**
 * Called on a DRAFT -> CONFIRMED transition. If this SO came from a background
 * scan and the operator confirmed it WITHOUT edits, promote its sample to
 * ACCEPTED so the few-shot pool learns from it.
 *
 * Best-effort and silent: never throws, never blocks the status change. A scan
 * sample failing to record must not cost the operator their confirm.
 */
export async function noteScanDraftAccepted(
  svc: SupabaseClient,
  docNo: string,
): Promise<void> {
  try {
    // 1. Did this SO come from a background scan?
    //    NOTE: scan_jobs.so_doc_no is NOT indexed (0067 indexes created_at +
    //    salesperson; 0068 adds sample_id — the existing lookups all travel
    //    sample_id -> so_doc_no, this is the only one going the other way), so
    //    this is a scan of a table holding one row per scan. Fine at today's
    //    volume and it fires only on DRAFT -> CONFIRMED, but an index on
    //    so_doc_no is the right follow-up — that needs a migration, which is
    //    staging-first and out of scope here.
    const { data: jobRow } = await svc
      .from('scan_jobs')
      .select('sample_id')
      .eq('so_doc_no', docNo)
      .not('sample_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!jobRow) return;
    // postgres.js camelCases columns; PostgREST does not. Dual-read is the
    // house rule (same shape as scan-so.ts's job serializer).
    const j = jobRow as { sampleId?: string | null; sample_id?: string | null };
    const sampleId = j.sampleId ?? j.sample_id ?? null;
    if (!sampleId) return;

    // 2. Did a human change anything before confirming? The scan job's own
    //    writes are excluded by action (CREATE) and by source: the pipeline
    //    tags its payment rows source='automation' (scan-so.ts), operator
    //    writes default to 'web'.
    //    `source IS NULL` must count as an EDIT: a bare .neq('source',...)
    //    resolves to NULL for those rows and Postgres drops them from the
    //    result, which would read a genuine edit as "no edits" and label a
    //    corrected slip ACCEPTED. Unknown provenance fails toward not learning.
    const { data: edits } = await svc
      .from('mfg_so_audit_log')
      .select('id')
      .eq('so_doc_no', docNo)
      .not('action', 'in', NON_EDIT_ACTIONS)
      .or('source.is.null,source.neq.automation')
      .limit(1);
    if (edits && edits.length > 0) return; // edited — see the header note.

    // 3. Promote EXTRACTED -> ACCEPTED, carrying `extracted` across verbatim.
    //    Filtering on status='EXTRACTED' is the double-confirm guard: if the
    //    interactive path already confirmed this sample, or a previous
    //    transition already accepted it, this matches 0 rows and does nothing.
    //    That keeps a scan counted exactly once no matter how many times the
    //    SO is re-confirmed (DRAFT -> CONFIRMED -> ON_HOLD -> CONFIRMED ...).
    const { data: sample } = await svc
      .from('so_scan_samples')
      .select('extracted, status')
      .eq('id', sampleId)
      .maybeSingle();
    const s = sample as { extracted?: unknown; status?: string | null } | null;
    if (!s || s.status !== SAMPLE_EXTRACTED || s.extracted == null) return;

    await svc
      .from('so_scan_samples')
      .update({ corrected: s.extracted, status: SAMPLE_ACCEPTED })
      .eq('id', sampleId)
      .eq('status', SAMPLE_EXTRACTED);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[scan-sample-review] accept note failed (non-fatal):', docNo, (e as Error).message);
  }
}
