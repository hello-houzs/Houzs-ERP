-- Role-based permissions matrix. Each (department, position, module) tuple
-- has a level:
--   NONE  = hidden (sidebar + routes reject)
--   VIEW  = read-only
--   EDIT  = create + update (no delete)
--   FULL  = CRUD incl delete

CREATE TABLE IF NOT EXISTS role_permissions (
  department  TEXT NOT NULL,       -- SALES / OPERATION / HQ
  position    TEXT NOT NULL,       -- "Sales Director", "Super Admin", etc.
  module_key  TEXT NOT NULL,       -- e.g. "so_details", "sku_costing"
  level       TEXT NOT NULL DEFAULT 'NONE',  -- NONE / VIEW / EDIT / FULL
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (department, position, module_key)
);
CREATE INDEX IF NOT EXISTS idx_role_perms_dept_pos ON role_permissions(department, position);
CREATE INDEX IF NOT EXISTS idx_role_perms_module ON role_permissions(module_key);
