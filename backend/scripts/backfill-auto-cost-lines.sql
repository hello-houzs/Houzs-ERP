-- One-shot backfill for the auto cost-line engine (mig 063).
--
-- Why this exists: the recompute service in
-- services/projectCostRates.ts runs every time a finance line
-- changes, but historical projects have never seen a finance edit
-- since 063 landed. This script reproduces the service logic in
-- SQL for a single batch backfill — same boost-tier rule, same
-- categories, same auto_source tags — so the existing 30+ seeded
-- projects pick up their rate-driven costs without us having to
-- touch each one through the UI.
--
-- Idempotent: deletes any prior auto rows first, then inserts fresh
-- ones. Safe to re-run.

-- 1. Wipe stale auto rows for active projects.
DELETE FROM project_finance_lines
 WHERE auto_source IS NOT NULL
   AND project_id IN (SELECT id FROM projects WHERE archived_at IS NULL);

-- 2. Re-insert from rate × per-project sums. CTE computes sales,
--    cogs, GP%, and the resolved commission rate per project; the
--    three INSERTs below pick the columns they need.
INSERT INTO project_finance_lines
  (project_id, kind, category, description, amount, auto_source, created_at)
WITH base AS (
  SELECT
    p.id AS project_id,
    p.brand,
    COALESCE(SUM(CASE WHEN l.kind='income' AND l.category='sales' AND l.auto_source IS NULL THEN l.amount END), 0) AS sales,
    COALESCE(SUM(CASE WHEN l.kind='cost'   AND l.category='cogs'  AND l.auto_source IS NULL THEN l.amount END), 0) AS cogs
  FROM projects p
  LEFT JOIN project_finance_lines l
    ON l.project_id = p.id AND l.archived_at IS NULL
  WHERE p.archived_at IS NULL AND p.brand IS NOT NULL
  GROUP BY p.id
), rated AS (
  SELECT
    b.project_id, b.brand, b.sales, b.cogs,
    CASE WHEN b.sales > 0 THEN ((b.sales - b.cogs) * 100.0 / b.sales) ELSE 0 END AS gp_pct,
    r.transport_pct, r.merchandise_pct,
    r.commission_normal_pct, r.commission_boost_pct,
    r.boost_min_gp_pct, r.boost_min_sales
  FROM base b
  JOIN project_cost_rates r ON r.brand = b.brand
  WHERE b.sales > 0
), resolved AS (
  SELECT
    project_id, sales, transport_pct, merchandise_pct,
    CASE
      WHEN commission_boost_pct IS NOT NULL
       AND (boost_min_gp_pct IS NULL OR gp_pct  >= boost_min_gp_pct)
       AND (boost_min_sales  IS NULL OR sales   >= boost_min_sales)
      THEN commission_boost_pct
      ELSE commission_normal_pct
    END AS commission_pct,
    CASE
      WHEN commission_boost_pct IS NOT NULL
       AND (boost_min_gp_pct IS NULL OR gp_pct  >= boost_min_gp_pct)
       AND (boost_min_sales  IS NULL OR sales   >= boost_min_sales)
      THEN 1 ELSE 0
    END AS used_boost
  FROM rated
)
SELECT
  project_id, 'cost', 'transport',
  'Transportation (auto · ' || CAST(transport_pct AS TEXT) || '% of sales)',
  ROUND(sales * transport_pct / 100.0, 2),
  'auto:transport',
  datetime('now')
FROM resolved
UNION ALL
SELECT
  project_id, 'cost', 'merchandise',
  'Merchandise (auto · ' || CAST(merchandise_pct AS TEXT) || '% of sales)',
  ROUND(sales * merchandise_pct / 100.0, 2),
  'auto:merchandise',
  datetime('now')
FROM resolved
UNION ALL
SELECT
  project_id, 'cost', 'commission',
  'Commission (auto · ' || CAST(commission_pct AS TEXT) || '% of sales' ||
    CASE used_boost WHEN 1 THEN ' — boost tier' ELSE '' END || ')',
  ROUND(sales * commission_pct / 100.0, 2),
  'auto:commission',
  datetime('now')
FROM resolved;
