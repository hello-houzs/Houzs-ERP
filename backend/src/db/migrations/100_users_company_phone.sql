-- 100_users_company_phone.sql
--
-- Boss-requested: every driver / helper (any user) can hold TWO phone
-- numbers — a personal line (the existing `phone` column) and a
-- separate company line. For now only the personal number is filled;
-- the company number is added manually later when needed.
--
-- Added to PROFILE_FIELDS (so it can be patched) and surfaced in the
-- staff detail SELECT. The project crew dropdown keeps auto-filling the
-- PERSONAL phone; the company number is reference-only for now.

ALTER TABLE users ADD COLUMN company_phone TEXT;
