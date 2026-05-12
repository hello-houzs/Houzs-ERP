-- One-shot backfill: clone the (refreshed in mig 066) checklist
-- templates into every active project. Mirrors the per-project clone
-- logic in services/projects.ts ::cloneChecklistFromTemplate but
-- runs set-based across all projects in 4 SQL statements.
--
-- 2026-05-08 — boss asked to seed the new PM Workflow tasklist into
-- every project. Pre-flight check showed 343 projects, 12 existing
-- checklist items, 0 ticked — safe to wipe + reseed.
--
-- Section_id mapping is solved by joining template_sections.name to
-- project_checklist_sections.name, which is unique per project.

-- 1. Wipe existing checklist items + sections on non-archived projects.
DELETE FROM project_checklist
 WHERE project_id IN (SELECT id FROM projects WHERE archived_at IS NULL);

DELETE FROM project_checklist_sections
 WHERE project_id IN (SELECT id FROM projects WHERE archived_at IS NULL);

-- 2. Clone template sections per project. Joins event_type → template
--    so each project gets the section set its event_type calls for.
INSERT INTO project_checklist_sections (project_id, name, sort_order)
SELECT p.id, s.name, s.sort_order
  FROM projects p
  JOIN project_event_types et ON et.id = p.event_type_id
  JOIN project_checklist_template_sections s ON s.template_id = et.default_template_id
 WHERE p.archived_at IS NULL;

-- 3. Clone template items per project. Maps section_id by joining
--    template_sections.name to the freshly inserted project_sections.
--    due_date computed off the project start_date + offset; '+N days'
--    or '-N days' modifier picked by sign of due_offset_days.
INSERT INTO project_checklist
  (project_id, section_id, seq, title, description, required_perm, due_date, due_offset_days)
SELECT
  p.id,
  ps.id,
  i.seq,
  i.title,
  i.description,
  COALESCE(
    i.required_perm,
    CASE WHEN i.requires_review = 1 THEN 'projects.approve' END
  ),
  CASE
    WHEN p.start_date IS NULL OR i.due_offset_days IS NULL THEN NULL
    WHEN i.due_offset_days >= 0
      THEN date(p.start_date, '+' || i.due_offset_days || ' days')
      ELSE date(p.start_date, CAST(i.due_offset_days AS TEXT) || ' days')
  END,
  i.due_offset_days
  FROM projects p
  JOIN project_event_types et ON et.id = p.event_type_id
  JOIN project_checklist_template_items i ON i.template_id = et.default_template_id
  LEFT JOIN project_checklist_template_sections ts ON ts.id = i.section_id
  LEFT JOIN project_checklist_sections ps
    ON ps.project_id = p.id AND ps.name = ts.name
 WHERE p.archived_at IS NULL;
