-- 096_role_chips_and_image_renames.sql
--
-- Boss-requested: show a PIC role chip (role_label) on items across
-- all sections, like Booth Layout. Also strip the "(Driver)" /
-- "(Sales PIC)" suffix from the Setup/Dismantle image titles and
-- carry that as the chip instead.
--
-- Roles set first (by original title), THEN the image renames run —
-- so the two Setup Image rows keep their distinct DRIVER / SALES PIC
-- chips even though both become titled "Setup Image".
-- Applied to templates + all existing projects. Idempotent.

-- ── BD ────────────────────────────────────────────────────────
UPDATE project_checklist_template_items SET role_label='BD'
 WHERE title IN ('Agreement / Quotation','Weekend Activity (Theme)','License (from Majlis)','Stamp Duty','Work / Loading Bay Permit','Deco / Coffee Table','Rental Payment','Security Deposit','Blank Floorplan');
UPDATE project_checklist SET role_label='BD'
 WHERE title IN ('Agreement / Quotation','Weekend Activity (Theme)','License (from Majlis)','Stamp Duty','Work / Loading Bay Permit','Deco / Coffee Table','Rental Payment','Security Deposit','Blank Floorplan');

-- ── SALES PIC ─────────────────────────────────────────────────
UPDATE project_checklist_template_items SET role_label='SALES PIC'
 WHERE title IN ('Defect List','Event Complete Image','Filled Floorplan','Setup Image (Sales PIC)');
UPDATE project_checklist SET role_label='SALES PIC'
 WHERE title IN ('Defect List','Event Complete Image','Filled Floorplan','Setup Image (Sales PIC)');

-- ── PURCHASER ─────────────────────────────────────────────────
UPDATE project_checklist_template_items SET role_label='PURCHASER'
 WHERE title IN ('Exchange List','Stock In Transfer Record');
UPDATE project_checklist SET role_label='PURCHASER'
 WHERE title IN ('Exchange List','Stock In Transfer Record');

-- ── DRIVER ────────────────────────────────────────────────────
UPDATE project_checklist_template_items SET role_label='DRIVER'
 WHERE title IN ('Setup Image (Driver)','Dismantle Image (Driver)');
UPDATE project_checklist SET role_label='DRIVER'
 WHERE title IN ('Setup Image (Driver)','Dismantle Image (Driver)');

-- ── Renames (after roles are set) ─────────────────────────────
UPDATE project_checklist_template_items SET title='Setup Image' WHERE title IN ('Setup Image (Driver)','Setup Image (Sales PIC)');
UPDATE project_checklist               SET title='Setup Image', updated_at=datetime('now') WHERE title IN ('Setup Image (Driver)','Setup Image (Sales PIC)');
UPDATE project_checklist_template_items SET title='Dismantle Image' WHERE title='Dismantle Image (Driver)';
UPDATE project_checklist               SET title='Dismantle Image', updated_at=datetime('now') WHERE title='Dismantle Image (Driver)';
