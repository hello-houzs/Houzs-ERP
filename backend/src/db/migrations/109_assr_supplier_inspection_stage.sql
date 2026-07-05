-- D1 test-mirror of migrations-pg/0072_assr_supplier_inspection_stage.sql.
-- Seeds SLA target rows for the new pending_supplier_inspection stage by
-- copying the Supplier Pickup targets.
--
-- NB: the D1 assr_cases.stage CHECK (mig 074 rebuild) intentionally is
-- NOT widened here — D1 is a schema mirror for the deploy gate, not a
-- runtime store (prod runs Postgres via Hyperdrive, which has no stage
-- CHECK). Rebuilding the whole table again for a test mirror isn't
-- worth the risk; if D1 ever becomes a runtime target, widen the CHECK
-- with a mig-074-style rebuild first.
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT t.profile_id, 'pending_supplier_inspection', t.target_days
  FROM assr_stage_targets t
 WHERE t.stage = 'pending_supplier_pickup'
   AND NOT EXISTS (
     SELECT 1 FROM assr_stage_targets x
      WHERE x.profile_id = t.profile_id
        AND x.stage = 'pending_supplier_inspection'
   );

INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days)
SELECT t.priority_id, 'pending_supplier_inspection', t.target_days
  FROM assr_priority_stage_targets t
 WHERE t.stage = 'pending_supplier_pickup'
   AND NOT EXISTS (
     SELECT 1 FROM assr_priority_stage_targets x
      WHERE x.priority_id = t.priority_id
        AND x.stage = 'pending_supplier_inspection'
   );
