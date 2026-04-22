-- Additional test accounts for admin to impersonate + verify RBAC + PIC access.
-- Password for all: Test@815518

-- 1. Sales Executive (regular sales person, no PIC assignments)
INSERT OR REPLACE INTO users (
  id, name, code, email, phone, department, position, parent_id,
  additional_parent_ids, join_date, status, assigned_brands,
  commission_tiers, min_rate,
  password_hash, password_salt, must_change_password
) VALUES (
  'exe-test',
  'TEST EXEC',
  'TESTEXE',
  'test-exec@houzscentury.com',
  '',
  'SALES',
  'Sales Executive',
  'dir-test',
  '[]',
  '2026-04-22',
  'ACTIVE',
  '["AKEMI","ZANOTTI"]',
  '[]',
  0,
  '843EM8oP5Z+j2wrQgCnN6M+JnyMpnfV3lshD0fDbtwg=',
  'zwUKKfWRhe0yECWGGzJWhw==',
  0
);

-- 2. Sales Executive assigned as PIC on upcoming events (test PIC-scoped view)
INSERT OR REPLACE INTO users (
  id, name, code, email, phone, department, position, parent_id,
  additional_parent_ids, join_date, status, assigned_brands,
  commission_tiers, min_rate,
  password_hash, password_salt, must_change_password
) VALUES (
  'exe-test-pic',
  'TEST PIC',
  'TESTPIC',
  'test-pic@houzscentury.com',
  '',
  'SALES',
  'Sales Executive',
  'dir-test',
  '[]',
  '2026-04-22',
  'ACTIVE',
  '["AKEMI","DUNLOPILLO"]',
  '[]',
  0,
  'CJejr/0+0FHTvb5+38aPQyNZ6ldyWTkf78P6AkwKpNU=',
  'ryhiHmR6QaI5Cd8gcxg7cw==',
  0
);

-- Assign TEST PIC as sales_pic + pic on a couple of upcoming events so the
-- "my events" filter has something to match against.
UPDATE events SET sales_pic = 'TEST PIC', pic = 'TEST PIC', assigned_sales = '["exe-test-pic"]'
 WHERE a42 = '2026-05-HOMELOVE-PENANG-SETIASPICECONVENTIONCENTRE-DUNLOPILLO';
UPDATE events SET sales_pic = 'TEST PIC', pic = 'TEST PIC', assigned_sales = '["exe-test-pic"]'
 WHERE a42 = '2026-05-MEGAHOME-SABAH-SICC-AKEMI';
