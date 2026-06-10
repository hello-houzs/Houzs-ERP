-- 097_phase_crew_json.sql
--
-- Boss-requested setup/dismantle crew editor: 2 drivers + 2 helpers
-- per phase (name + phone), lorries, and an "Outsourced" entry
-- (name / phone / lorry plate). Stored as JSON per phase to avoid ~20
-- flat columns. The detail query already returns p.* so these surface
-- automatically; PATCH_FIELDS gains setup_crew / dismantle_crew.
--
-- Shape: {"drivers":[{"name","phone"}],"helpers":[{"name","phone"}],
--         "lorries":["PLATE"],
--         "outsourced":{"enabled":bool,"name","phone","plate"}}

ALTER TABLE projects ADD COLUMN setup_crew TEXT;
ALTER TABLE projects ADD COLUMN dismantle_crew TEXT;
