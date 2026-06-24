// ---------------------------------------------------------------------------
// /slips — payment-slip presigned-PUT upload session (init → browser PUT →
// confirm). Ported from 2990's apps/api/src/routes/slips.ts and adapted to
// Houzs conventions.
//
// The frontend (frontend/src/vendor/scm/lib/slip.ts: initSlipUpload →
// putToR2 → confirmUpload, via uploadSlipFull ← SlipUploadField ←
// PaymentsTable ← New SO) calls:
//   POST /slips/init               { fileSize, contentType, contentHash }
//                                  → { uploadSessionId, putUrl, r2Key }
//   POST /slips/:session/confirm   → { ok: true } (frontend only checks res.ok)
//
// The SO-create + add-payment handlers (mfg-sales-orders.ts) CONSUME the
// resulting pending_slip_uploads row by upload_session_id, accepting only
// status 'uploaded' (then promoting to 'promoted'). This route PRODUCES that
// row. Without it the New-SO payment-slip upload 404s on /slips/init.
//
// Houzs adaptations vs 2990:
//   - Auth: supabaseAuth (same as the other ported routes) attaches the
//     scm-scoped service client + the SCM_SYSTEM_STAFF_ID user. RLS does not
//     apply (service role), so the showroom fallback below is purely to
//     satisfy the NOT NULL FK pending_slip_uploads.showroom_id → scm.showrooms.
//   - R2: presigned PUT via slipBindings/presign + r2HeadViaS3 (lib/r2.ts,
//     lib/slip.ts). The SLIPS binding + R2 S3 creds are intentionally unbound
//     until configured (wrangler.toml) — slipBindings() throws a clear error
//     until then, so /slips/* 500s loudly rather than silently mis-storing.
//   - camelCase??snake_case dual-read on the request body.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { slipBindings, expiresInOneHour } from '../lib/slip';
import { buildSlipKey, presign, r2HeadViaS3, type SlipMime } from '../lib/r2';

export const slips = new Hono<{ Bindings: Env; Variables: Variables }>();
slips.use('*', supabaseAuth);

const ALLOWED_MIMES: ReadonlySet<SlipMime> = new Set<SlipMime>([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);
// Mirror the frontend's MAX_SLIP_SIZE_BYTES (5 MiB) — a hard ceiling so a
// bad/huge upload can't reserve an oversized R2 object.
const MAX_SLIP_SIZE_BYTES = 5 * 1024 * 1024;

slips.post('/init', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  // Dual-read camelCase ?? snake_case (the frontend sends camelCase).
  const contentType = (body.contentType ?? body.content_type) as string | undefined;
  const fileSize = Number(body.fileSize ?? body.file_size ?? NaN);
  const contentHash = (body.contentHash ?? body.content_hash) as string | undefined;

  if (!contentType || !ALLOWED_MIMES.has(contentType as SlipMime)) {
    return c.json({ error: 'invalid_request', reason: 'unsupported content_type' }, 400);
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_SLIP_SIZE_BYTES) {
    return c.json({ error: 'invalid_request', reason: 'invalid file_size' }, 400);
  }
  if (!contentHash || typeof contentHash !== 'string') {
    return c.json({ error: 'invalid_request', reason: 'missing content_hash' }, 400);
  }

  const sb = c.get('supabase');
  const staffId = (c.get('user') as User).id;
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }

  // pending_slip_uploads.showroom_id is NOT NULL (FK → scm.showrooms). Houzs
  // has no showroom concept and the system staff carries none, so stamp the
  // first active showroom (by sort_order). 2990 did the same fallback for
  // elevated roles. No showroom seeded → a clear error rather than a FK 500.
  const { data: defaultRoom, error: roomErr } = await sb
    .from('showrooms')
    .select('id')
    .eq('active', true)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (roomErr) return c.json({ error: 'showroom_lookup_failed', reason: roomErr.message }, 500);
  const showroomId = (defaultRoom as { id?: string } | null)?.id ?? null;
  if (!showroomId) return c.json({ error: 'no_active_showroom' }, 400);

  const sessionId = crypto.randomUUID();
  const r2Key = buildSlipKey(sessionId, contentType as SlipMime);
  const expiresAt = expiresInOneHour();

  const { error: insertErr } = await sb.from('pending_slip_uploads').insert({
    id: sessionId,
    upload_session_id: sessionId,
    staff_id: staffId,
    showroom_id: showroomId,
    r2_key: r2Key,
    content_type: contentType,
    content_hash: contentHash,
    content_size: Math.round(fileSize),
    status: 'pending',
    expires_at: expiresAt,
  });
  if (insertErr) return c.json({ error: 'db_insert_failed', reason: insertErr.message }, 500);

  const putUrl = await presign({
    bucket: bindings.bucketName,
    region: 'auto',
    accessKeyId: bindings.accessKeyId,
    secretAccessKey: bindings.secretAccessKey,
    endpoint: bindings.endpoint,
    key: r2Key,
    method: 'PUT',
    expiresInSeconds: 5 * 60,
    contentType,
  });

  return c.json({ uploadSessionId: sessionId, putUrl, r2Key });
});

slips.post('/:session/confirm', async (c) => {
  const sessionId = c.req.param('session');
  const sb = c.get('supabase');
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }

  const { data: row, error: fetchErr } = await sb
    .from('pending_slip_uploads')
    .select('id, r2_key, content_size, status')
    .eq('upload_session_id', sessionId)
    .maybeSingle();
  if (fetchErr) return c.json({ error: 'db_fetch_failed', reason: fetchErr.message }, 500);
  if (!row) return c.json({ error: 'session_not_found' }, 404);

  const r = row as { id: string; r2_key: string; content_size: number | null; status: string };
  // Idempotent confirm — a re-confirm of an already-uploaded session is a no-op
  // success (the frontend only checks res.ok). A promoted/failed row is a hard
  // state error.
  if (r.status === 'uploaded') return c.json({ ok: true });
  if (r.status !== 'pending') {
    return c.json({ error: 'invalid_state', currentStatus: r.status }, 409);
  }

  // Verify the browser's presigned PUT actually landed in R2. Via the S3 API
  // (not the binding) so dev (Miniflare) and prod hit the same backend.
  const head = await r2HeadViaS3({
    bucket: bindings.bucketName,
    accessKeyId: bindings.accessKeyId,
    secretAccessKey: bindings.secretAccessKey,
    endpoint: bindings.endpoint,
    key: r.r2_key,
  });
  if (!head) return c.json({ error: 'file_not_in_r2' }, 404);

  // Size check (R2 etag for an unencrypted PUT is md5, not sha256; we only
  // assert the byte count here — the hash is recorded for future strict check).
  if (r.content_size != null && head.size !== r.content_size) {
    await sb.from('pending_slip_uploads')
      .update({ status: 'failed', error_msg: 'size_mismatch' })
      .eq('upload_session_id', sessionId);
    await bindings.bucket.delete(r.r2_key).catch(() => {});
    return c.json({ error: 'size_mismatch', expected: r.content_size, actual: head.size }, 400);
  }

  const { error: updateErr } = await sb
    .from('pending_slip_uploads')
    .update({ status: 'uploaded' })
    .eq('upload_session_id', sessionId);
  if (updateErr) return c.json({ error: 'db_update_failed', reason: updateErr.message }, 500);

  return c.json({ ok: true });
});

export default slips;
