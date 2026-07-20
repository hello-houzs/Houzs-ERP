import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseService } from '../../db/supabase';
import type { Env } from '../env';
import { recomputeSoStockAllocation } from './so-stock-allocation';
import { deferScmAfterCommit } from './pg-supabase-transaction';

const JOB_KEY = 'GLOBAL';
const LEASE_MS = 4 * 60_000;

type QueueRow = {
  job_key: string;
  request_token: string;
  requested_at: string;
  attempts: number;
};

export type AllocationDrainResult = {
  processed: boolean;
  completed: boolean;
  deferred?: boolean;
  reason?: string;
};

/** Persist the invalidation in the caller's transaction. */
export async function enqueueStockAllocationRecompute(sb: any, reason: string): Promise<void> {
  const { error } = await sb.from('stock_allocation_recompute_queue').upsert({
    job_key: JOB_KEY,
    request_token: crypto.randomUUID(),
    requested_at: new Date().toISOString(),
    reason,
    attempts: 0,
    last_error: null,
  }, { onConflict: 'job_key' });
  if (error) throw new Error(`Stock-allocation enqueue failed: ${error.message}`);
}

/**
 * Claim and drain the singleton projection job. The random request_token
 * equality on claim/delete is the generation fence: a mutation arriving during
 * recompute gets a new token, so the old worker can never delete the new work,
 * even when two enqueues share one clock millisecond.
 */
export async function drainStockAllocationRecomputeWithClient(
  sb: any,
  recompute: typeof recomputeSoStockAllocation = recomputeSoStockAllocation,
): Promise<AllocationDrainResult> {
  const { data: pending, error: loadError } = await sb.from('stock_allocation_recompute_queue')
    .select('job_key, request_token, requested_at, attempts')
    .eq('job_key', JOB_KEY)
    .maybeSingle();
  if (loadError) return { processed: false, completed: false, reason: loadError.message };
  if (!pending) return { processed: false, completed: true };

  const row = pending as QueueRow;
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + LEASE_MS).toISOString();
  const { data: claimed, error: claimError } = await sb.from('stock_allocation_recompute_queue')
    .update({ locked_by: token, locked_until: lockedUntil })
    .eq('job_key', JOB_KEY)
    .eq('request_token', row.request_token)
    .or(`locked_by.is.null,locked_until.lt.${now}`)
    .select('job_key')
    .maybeSingle();
  if (claimError) return { processed: false, completed: false, reason: claimError.message };
  if (!claimed) return { processed: false, completed: false, deferred: true, reason: 'job_already_claimed' };

  let failure: string | null = null;
  try {
    const result = await recompute(sb);
    if (!result.ok) failure = result.reason ?? 'stock allocation returned ok=false';
    else if (result.reason === 'another_recompute_in_progress') failure = result.reason;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (failure) {
    const { error } = await sb.from('stock_allocation_recompute_queue').update({
      attempts: Number(row.attempts ?? 0) + 1,
      last_error: failure,
      locked_by: null,
      locked_until: null,
    }).eq('job_key', JOB_KEY).eq('locked_by', token);
    return {
      processed: true,
      completed: false,
      deferred: failure === 'another_recompute_in_progress',
      reason: error ? `${failure}; queue release failed: ${error.message}` : failure,
    };
  }

  const { data: deleted, error: deleteError } = await sb.from('stock_allocation_recompute_queue')
    .delete()
    .eq('job_key', JOB_KEY)
    .eq('locked_by', token)
    .eq('request_token', row.request_token)
    .select('job_key')
    .maybeSingle();
  if (deleteError) return { processed: true, completed: false, reason: deleteError.message };
  if (!deleted) {
    // New work arrived while recompute ran. Release only our lease; keep it queued.
    const { error } = await sb.from('stock_allocation_recompute_queue').update({
      locked_by: null,
      locked_until: null,
    }).eq('job_key', JOB_KEY).eq('locked_by', token);
    return {
      processed: true,
      completed: false,
      deferred: true,
      reason: error ? `new_work_arrived; queue release failed: ${error.message}` : 'new_work_arrived',
    };
  }
  return { processed: true, completed: true };
}

export async function drainStockAllocationRecompute(env: Env): Promise<AllocationDrainResult> {
  return drainStockAllocationRecomputeWithClient(getSupabaseService(env));
}

/** Queue transactionally, then make one after-commit attempt for low latency. */
export async function scheduleStockAllocationAfterCommand(c: any, sb: any, reason: string): Promise<void> {
  await enqueueStockAllocationRecompute(sb, reason);
  deferScmAfterCommit(c, async () => {
    const attempt = drainStockAllocationRecomputeWithClient(c.get('supabase') as SupabaseClient)
      .then((result) => {
        if (!result.completed && !result.deferred) throw new Error(result.reason ?? 'stock-allocation drain failed');
      });
    // The durable row is already committed, so the response need not wait for
    // a global allocation sweep. waitUntil keeps the low-latency attempt alive;
    // environments without it await as a safe fallback.
    try { c.executionCtx.waitUntil(attempt); }
    catch { await attempt; }
  });
}
