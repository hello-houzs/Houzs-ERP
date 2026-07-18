-- 0139_grant_scm_config_write_to_purchaser_role.sql
--
-- SYMPTOM. The Procurement/Purchasing position gets "You don't have permission
-- to do that" when it tries to IMPORT SKUs on the Products page (POST
-- /api/scm/mfg-products/batch-import) and on every other SCM master-data write.
-- Purchasing OWNS product / SKU / price master data (owner, 2026-07-18), so this
-- is wrong.
--
-- WHY. There are two permission layers and they disagree:
--   1. PAGE ACCESS (services/positionPolicy.ts) — Procurement/Purchasing is NOT
--      a restricted or sales position, so it fails OPEN to FULL page access and
--      SEES every SCM page, Products included.
--   2. FLAT PERMISSIONS (roles.permissions, checked by hasHouzsPerm) — the SKU
--      import and all SCM master-data writes are gated in-route on the flat key
--      `scm.config.write` (mfg-products.ts requireRole, product-models.ts,
--      categories.ts, delivery-fees.ts, sofa-combos.ts, fabric-*, pwp-rules.ts,
--      maintenance-config.ts, special-addons.ts, ... 29 call sites). Purchasing's
--      ROLE does not carry `scm.config.write`, so full PAGE access is denied the
--      WRITE.
--
-- Role 322 "Purchaser" is the SCM operation role: migration 0031 granted it
-- `scm.access` (the /api/scm/* mount gate) so Purchasing could reach the SCM
-- modules at all. A user who can SEE the Products page has passed that mount,
-- i.e. holds `scm.access`, which 0031 gave only to role 322 (Purchaser) and 326
-- (Storekeeper) — and Storekeeper's page policy DENIES the Products page. So the
-- symptomatic Purchasing user is on role 322. This grants that same role the
-- master-data WRITE it was missing, extending 0031's proven pattern.
--
-- SCOPE / OVER-GRANT GUARD. `scm.config.write` is the single coarse "edit SCM
-- master data" key (permissions.ts): products, sofa combos, delivery fees,
-- fabric library + tier add-ons, PWP rules, sofa quick picks, special add-ons,
-- Maintenance config, category hero images. All of that is Purchasing's remit.
-- Role 326 (Storekeeper) is DELIBERATELY NOT granted here — Storekeeper is a
-- restricted, view-only inventory cohort in positionPolicy and must keep every
-- stock/master write 403'd. No money-moving key (scm.payment_voucher.*,
-- scm.finance accounting) and no HR key (scm.hr.*) is touched.
--
-- roles.permissions is a TEXT column holding a JSON array as text (default '[]'),
-- so we cast to jsonb to append, then cast back to text to store. The jsonb @>
-- guard makes this idempotent: re-running is a no-op once the key is present, and
-- it never clobbers any other perm the owner added by hand. No inner
-- BEGIN/COMMIT (the runner owns the txn).

UPDATE roles
   SET permissions = ((permissions::jsonb) || '["scm.config.write"]'::jsonb)::text
 WHERE id = 322
   AND NOT ((permissions::jsonb) @> '"scm.config.write"'::jsonb);
