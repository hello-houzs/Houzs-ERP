-- 094_rename_2d_design.sql
--
-- Boss-requested: rename "2D Design with Display" -> "2D Design"
-- on the templates and every existing project. Idempotent.

UPDATE project_checklist_template_items
   SET title = '2D Design'
 WHERE title = '2D Design with Display';

UPDATE project_checklist
   SET title = '2D Design',
       updated_at = datetime('now')
 WHERE title = '2D Design with Display';
