-- Temporary test account for Super Admin to impersonate a Sales Director
-- and verify what the director's portal looks like. Delete via Users page
-- when done testing.

INSERT OR REPLACE INTO users (
  id, name, code, email, phone, department, position, parent_id,
  additional_parent_ids, join_date, status, assigned_brands,
  commission_tiers, min_rate,
  password_hash, password_salt, must_change_password
) VALUES (
  'dir-test',
  'TEST DIRECTOR',
  'TESTDIR',
  'test-director@houzscentury.com',
  '',
  'SALES',
  'Sales Director',
  NULL,
  '[]',
  '2026-04-22',
  'ACTIVE',
  '["AKEMI","ZANOTTI","ERGOTEX","DUNLOPILLO","HOUZS"]',
  '[]',
  0,
  'kdgvBavWuk+bJ3N4epiNtMN+hDHxqLtwWSu4zltsOfQ=',
  'jXIm1ka8q6OjSgXxDf7RrA==',
  0
);
