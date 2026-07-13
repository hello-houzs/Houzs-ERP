-- ─────────────────────────────────────────────────────────────────────────
-- Phase 0e — per-company user access grants.
--
-- STAGED for Phase 0f: do NOT move this file into
-- backend/src/db/migrations-pg/ until it has been staging-tested. Houzs CI
-- auto-applies EVERYTHING in migrations-pg/ to prod on deploy — landing this
-- table there prematurely would activate per-user company gating in prod
-- before Phase 0f. Keep it here in the scratchpad staging dir until then.
--
-- Mirrors user_brands (mig 049): a per-user allow-list, replace-set semantics.
-- Composite PK (user_id, company_id) makes each grant unique; the extra index
-- on user_id speeds the per-request lookup in companyContext.
--
-- FK types match the referenced PKs exactly:
--   public.users.id      -> serial  (int4 / integer)
--   public.companies.id  -> bigint identity (int8 / bigint)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_companies (
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id bigint NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_user_companies_user ON public.user_companies (user_id);
