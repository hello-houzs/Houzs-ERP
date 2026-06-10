-- 095_move_floorplan_remove_3d_approval.sql
--
-- Boss-requested (templates + every existing project):
--   1. Move 'Display Floor Plan' above '3D Design' in BOOTH LAYOUT &
--      SETUP — seq 125 -> 105 (Stock Out=100, 3D Design=110).
--   2. Remove the entire '3D APPROVAL' section and its items
--      ('3D Checked by MGT', '3D Approved by Peter'). 3D is now
--      handled by '3D Design' under Booth Layout.
--
-- Attachment/comment rows for the removed items are deleted first
-- (FK cascade isn't guaranteed in D1). Idempotent.

-- ── 1. Reorder Display Floor Plan ─────────────────────────────
UPDATE project_checklist_template_items SET seq = 105 WHERE title = 'Display Floor Plan';
UPDATE project_checklist               SET seq = 105 WHERE title = 'Display Floor Plan';

-- ── 2. Remove 3D APPROVAL (items first, then section) ─────────
DELETE FROM project_checklist_attachments
 WHERE item_id IN (SELECT id FROM project_checklist WHERE title IN ('3D Checked by MGT','3D Approved by Peter'));
DELETE FROM project_checklist_comments
 WHERE item_id IN (SELECT id FROM project_checklist WHERE title IN ('3D Checked by MGT','3D Approved by Peter'));
DELETE FROM project_checklist
 WHERE title IN ('3D Checked by MGT','3D Approved by Peter');
DELETE FROM project_checklist_template_items
 WHERE title IN ('3D Checked by MGT','3D Approved by Peter');
DELETE FROM project_checklist_sections          WHERE name = '3D APPROVAL';
DELETE FROM project_checklist_template_sections WHERE name = '3D APPROVAL';
