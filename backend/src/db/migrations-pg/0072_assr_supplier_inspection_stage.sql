-- New workflow stage: pending_supplier_inspection (Nick 2026-07-05).
-- Sits between Supplier Pickup and Item Ready — the item is at the
-- supplier's site being inspected/serviced. Also a status value in the
-- historical farra sheet ("Pending Supplier  Inspection").
--
-- assr_cases.stage carries no CHECK in Postgres, so only the SLA
-- target tables need rows. Seed by copying the Supplier Pickup targets
-- (same tier of work) for every profile / priority that has one.
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
