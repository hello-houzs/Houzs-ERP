-- Reset KINGSLEY / KRIS / PETER back to NOT_INVITED state so they don't
-- appear in the admin switcher. They got temp passwords during earlier
-- testing; clear them here. When admin actually wants to onboard them
-- they can click [Invite] on the Users page.

UPDATE users
   SET password_hash = NULL,
       password_salt = NULL,
       must_change_password = 0,
       last_login = NULL
 WHERE id IN ('dir-kingsley', 'dir-kris', 'dir-peter');
