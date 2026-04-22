-- Per user request: Sales Director sees ONLY PM + SALES + QMS (not ADMIN).
-- HQ Super Admin keeps full access to everything.

UPDATE role_permissions SET level = 'NONE'
 WHERE department = 'SALES' AND position = 'Sales Director'
   AND module_key IN ('admin_users', 'admin_audit', 'admin_permissions');
