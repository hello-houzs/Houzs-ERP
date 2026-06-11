-- 099_contract_documents_mode.sql
--
-- Boss-requested: render the CONTRACT section as the 6-column document
-- table (like BOOTH LAYOUT & SETUP) instead of the checklist list.
-- Templates + all existing projects. Idempotent.

UPDATE project_checklist_template_sections
   SET display_mode = 'documents'
 WHERE name = 'CONTRACT';
UPDATE project_checklist_sections
   SET display_mode = 'documents'
 WHERE name = 'CONTRACT';
