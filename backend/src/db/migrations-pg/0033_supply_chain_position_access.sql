-- 0033_supply_chain_position_access.sql
--
-- Make Supply Chain (furniture SCM, /scm/*) access configurable per POSITION.
--
-- The backend now exposes a `supply_chain` page in the PAGES catalogue
-- (services/pageAccess.ts) so it renders as a row in the Positions access
-- editor, and `hydrateAuthUser` derives the `scm.access` permission for
-- positioned users from that page's level (services/auth.ts). The /scm/*
-- route + menu + API guards are unchanged — they still check `scm.access`,
-- which is now position-driven for anyone who has a position.
--
-- Seed `supply_chain = full` for the Operation Department chain that
-- previously reached SCM via the role-level `scm.access` grant, so they keep
-- access after the switch to position-driven gating. Owner / IT Admin hold
-- "*" and bypass the matrix entirely, so they are not seeded here.
--
-- Idempotent: matches positions by name and ON CONFLICT DO NOTHING. Wrapped
-- in a guard so it is a harmless no-op on any database that predates the
-- position tables (e.g. a legacy pre-cutover instance).

DO $$
BEGIN
  IF to_regclass('public.position_page_access') IS NOT NULL THEN
    INSERT INTO position_page_access (position_id, page_key, level)
    SELECT p.id, 'supply_chain', 'full'
      FROM positions p
     WHERE p.name IN (
       'Ops Director', 'Ops Manager', 'Ops Executive', 'Logistic',
       'Purchasing', 'Storekeeper', 'Storekeeper Supervisor'
     )
    ON CONFLICT (position_id, page_key) DO NOTHING;
  END IF;
END $$;
