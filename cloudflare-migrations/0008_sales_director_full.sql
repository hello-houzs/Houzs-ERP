-- Bump SALES / Sales Director to FULL across all PM + SALES + QMS modules
-- (per user request — they should own all these areas).

UPDATE role_permissions SET level = 'FULL'
 WHERE department = 'SALES' AND position = 'Sales Director'
   AND module_key IN (
     'dashboard', 'calendar', 'finance', 'pms', 'settings',
     'sales_team', 'so_details', 'so', 'sku_costing',
     'qms'
   );
