-- 098_stock_in_description.sql
--
-- Boss-requested: add the description "Item exchange due to defect"
-- under the "Stock In Transfer Record" item. Templates + all existing
-- projects. Idempotent.

UPDATE project_checklist_template_items
   SET description = 'Item exchange due to defect'
 WHERE title = 'Stock In Transfer Record';

UPDATE project_checklist
   SET description = 'Item exchange due to defect',
       updated_at = datetime('now')
 WHERE title = 'Stock In Transfer Record';
