-- Add department column to users — foundation for role-based module permissions.
-- Values: SALES / OPERATION / HQ (enforced in app code, not SQL).
-- Positions (existing column) stay as-is; in Phase 2 we'll scope valid
-- positions by department.

ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT 'SALES';
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department);

-- Existing Sales Directors / Managers / Executives / Trainees stay as SALES
-- (that's the DEFAULT). Bootstrap admin gets promoted to HQ.
UPDATE users SET department = 'HQ' WHERE id = 'dir-hello';
