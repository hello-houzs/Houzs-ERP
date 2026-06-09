-- 093_booth_layout_documents_mode.sql
--
-- Boss-requested: render BOOTH LAYOUT & SETUP as the 6-column
-- document table (DOCUMENT / REMARKS / FILES / UPLOADED BY /
-- APPROVAL / ACTIONS) instead of the checklist list, and add a
-- "Display Floor Plan" document.
--
--   - Set the section display_mode = 'documents' (templates + every
--     existing project). The frontend renders the table when a
--     section is in this mode.
--   - Add 'Display Floor Plan' after '2D Design with Display'
--     (seq 125), role BD.
--   - Set role chips to match the requested layout:
--       Stock Out Transfer Record -> PURCHASER
--       3D Design / 2D Design with Display / Display Floor Plan -> BD
--
-- Applied to templates (future projects) and all existing projects.
-- Idempotent. To roll back the visual change, set display_mode back
-- to 'list'.

-- ── display_mode = 'documents' ────────────────────────────────
UPDATE project_checklist_template_sections
   SET display_mode = 'documents'
 WHERE name = 'BOOTH LAYOUT & SETUP';
UPDATE project_checklist_sections
   SET display_mode = 'documents'
 WHERE name = 'BOOTH LAYOUT & SETUP';

-- ── Add 'Display Floor Plan' to templates ─────────────────────
INSERT INTO project_checklist_template_items
  (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id, role_label, crew_visible)
  SELECT s.template_id, 125, 'Display Floor Plan', NULL, -21, NULL, 0, s.id, 'BD', 0
    FROM project_checklist_template_sections s
   WHERE s.name = 'BOOTH LAYOUT & SETUP'
     AND NOT EXISTS (
       SELECT 1 FROM project_checklist_template_items i
        WHERE i.template_id = s.template_id AND i.title = 'Display Floor Plan'
     );

-- ── Add 'Display Floor Plan' to every existing project ────────
INSERT INTO project_checklist
  (project_id, section_id, seq, title, description, required_perm,
   role_label, crew_visible, due_date, due_offset_days, status)
  SELECT s.project_id, s.id, 125, 'Display Floor Plan', NULL, NULL,
         'BD', 0,
         CASE WHEN p.start_date IS NOT NULL AND p.start_date <> ''
              THEN date(p.start_date, '-21 days') ELSE NULL END,
         -21, 'pending'
    FROM project_checklist_sections s
    JOIN projects p ON p.id = s.project_id
   WHERE s.name = 'BOOTH LAYOUT & SETUP'
     AND NOT EXISTS (
       SELECT 1 FROM project_checklist c
        WHERE c.project_id = s.project_id AND c.title = 'Display Floor Plan'
     );

-- ── Role chips (templates + existing projects) ────────────────
UPDATE project_checklist_template_items SET role_label = 'PURCHASER' WHERE title = 'Stock Out Transfer Record';
UPDATE project_checklist               SET role_label = 'PURCHASER' WHERE title = 'Stock Out Transfer Record';
UPDATE project_checklist_template_items SET role_label = 'BD' WHERE title IN ('3D Design', '2D Design with Display');
UPDATE project_checklist               SET role_label = 'BD' WHERE title IN ('3D Design', '2D Design with Display');
