-- 0162_scm_stock_allocation_recompute_queue.sql
-- Durable singleton invalidation for the global SO stock-allocation projection.
-- A command updates source-of-truth rows and this queue row in the SAME DB
-- transaction. The inline drain is only a latency optimisation; the five-minute
-- cron retries the row until recompute succeeds, so a Worker crash cannot leave
-- READY/PENDING and the SO header permanently stale.

CREATE TABLE IF NOT EXISTS scm.stock_allocation_recompute_queue (
  job_key       text PRIMARY KEY DEFAULT 'GLOBAL' CHECK (job_key = 'GLOBAL'),
  request_token uuid NOT NULL DEFAULT gen_random_uuid(),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  reason        text,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  locked_by     uuid,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scm.stock_allocation_recompute_queue ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.stock_allocation_recompute_queue TO service_role;

CREATE INDEX IF NOT EXISTS idx_stock_allocation_queue_lease
  ON scm.stock_allocation_recompute_queue (locked_until);

-- PostgREST calls do not share one PostgreSQL session, so a session advisory
-- lock acquired by one RPC cannot protect the reads/writes sent by later RPCs.
-- Every allocation entry point contends on this durable lease instead.
CREATE TABLE IF NOT EXISTS scm.stock_allocation_recompute_lock (
  lock_key     text PRIMARY KEY DEFAULT 'GLOBAL' CHECK (lock_key = 'GLOBAL'),
  locked_by    uuid,
  locked_until timestamptz
);

INSERT INTO scm.stock_allocation_recompute_lock (lock_key)
VALUES ('GLOBAL')
ON CONFLICT (lock_key) DO NOTHING;

ALTER TABLE scm.stock_allocation_recompute_lock ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.stock_allocation_recompute_lock TO service_role;

NOTIFY pgrst, 'reload schema';
