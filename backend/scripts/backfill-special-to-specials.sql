-- ============================================================================
-- Backfill: normalise the legacy singular variants.special -> variants.specials
-- (array). Part of the Special Order unification (owner 2026-07-20).
--
-- WHY. The receiving-family editors (New GRN, GRN Edit, Purchase Invoice,
-- Purchase Return, Stock Adjustment) used to store the special order as a SINGLE
-- string under variants.special, while the SO/PO/DO always used variants.specials
-- (an array of add-on codes). The shared SpecialOrders block now writes the array
-- everywhere. This one-shot moves the historical singular key onto the array so
-- every stored line reads the same shape.
--
-- SAFE + DISPLAY-ONLY. buildVariantSummary already reads `specials ?? special`,
-- so the printed Description 2 is byte-identical before and after. The stored
-- inventory variant_key is NOT touched (computeVariantKey only ever read
-- `specials`, never the singular `special`, so the singular value was never part
-- of any FIFO bucket) — this backfill cannot re-bucket or re-price anything.
--
-- IDEMPOTENT. Re-running is a no-op: once a row has a `specials` array and no
-- `special` key, neither statement matches it again.
--
-- SCOPE. Only the three tables whose editors wrote the singular key. The SO / PO
-- / DO item tables always used the array, so they are intentionally omitted.
--
-- ── STAGING FIRST (owner rule: staging-first data ops) ──────────────────────
--   Staging DB minnapsemfzjmtvnnvdd — validate here BEFORE prod.
--   Prod DB anogrigyjbduyzclzjgn — apply only after owner sign-off. Do NOT run
--   prod from an agent session.
--
--   Runner (reads DATABASE_URL from backend/.dev.vars):
--     node scripts/apply-sql-file.mjs scripts/backfill-special-to-specials.sql
--
--   Dry-run counts (how many rows WILL change) — run before + after; after = 0:
--     SELECT 'grn_items' t, count(*) FROM scm.grn_items
--       WHERE variants ? 'special';
--     SELECT 'purchase_invoice_items' t, count(*) FROM scm.purchase_invoice_items
--       WHERE variants ? 'special';
--     SELECT 'purchase_return_items' t, count(*) FROM scm.purchase_return_items
--       WHERE variants ? 'special';
-- ============================================================================

-- grn_items — move a non-empty singular special onto the specials array (or, when
-- an array already exists, just drop the redundant singular key).
UPDATE scm.grn_items
SET variants = CASE
    WHEN jsonb_typeof(variants->'specials') = 'array' AND jsonb_array_length(variants->'specials') > 0
      THEN variants - 'special'
    ELSE (variants - 'special') || jsonb_build_object('specials', jsonb_build_array(variants->>'special'))
  END
WHERE variants ? 'special' AND btrim(coalesce(variants->>'special', '')) <> '';

-- grn_items — drop empty singular special keys (hygiene).
UPDATE scm.grn_items
SET variants = variants - 'special'
WHERE variants ? 'special' AND btrim(coalesce(variants->>'special', '')) = '';

-- purchase_invoice_items
UPDATE scm.purchase_invoice_items
SET variants = CASE
    WHEN jsonb_typeof(variants->'specials') = 'array' AND jsonb_array_length(variants->'specials') > 0
      THEN variants - 'special'
    ELSE (variants - 'special') || jsonb_build_object('specials', jsonb_build_array(variants->>'special'))
  END
WHERE variants ? 'special' AND btrim(coalesce(variants->>'special', '')) <> '';

UPDATE scm.purchase_invoice_items
SET variants = variants - 'special'
WHERE variants ? 'special' AND btrim(coalesce(variants->>'special', '')) = '';

-- purchase_return_items
UPDATE scm.purchase_return_items
SET variants = CASE
    WHEN jsonb_typeof(variants->'specials') = 'array' AND jsonb_array_length(variants->'specials') > 0
      THEN variants - 'special'
    ELSE (variants - 'special') || jsonb_build_object('specials', jsonb_build_array(variants->>'special'))
  END
WHERE variants ? 'special' AND btrim(coalesce(variants->>'special', '')) <> '';

UPDATE scm.purchase_return_items
SET variants = variants - 'special'
WHERE variants ? 'special' AND btrim(coalesce(variants->>'special', '')) = '';
