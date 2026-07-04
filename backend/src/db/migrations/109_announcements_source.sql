-- D1 mirror of migrations-pg/0071 (dual migration tree). See that file.
ALTER TABLE announcements ADD COLUMN source text;
