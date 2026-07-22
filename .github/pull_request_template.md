## Scope

- [ ] This PR has one bounded purpose and names the affected modules.
- [ ] Backend/API/database/migration/permission changes are either absent or link the owner's explicit approval below.

Backend approval (required when applicable): N/A

## Regression proof

- Bug / hardening ID:
- Failing-before test or written waiver:
- Passing-after command and result:
- [ ] `BUG-HISTORY.md` links the regression evidence for a bug fix.
- [ ] No `.only` / skipped critical proof was introduced.

## Release safety

- [ ] Typecheck, tests and production build pass for every changed app.
- [ ] Frontend changes pass bundle and service-worker gates.
- [ ] Search/list changes state `SERVER_ALL`, `CLIENT_ALL` or `CLIENT_CAPPED` and test page reset plus A→A1 stale races.
- [ ] Mutation changes test failure UX, retry/duplicate-click behavior and preserved user input.
- [ ] Migration changes document target, checksum/drift behavior, rollback/restore and failure injection.
- [ ] PII, tokens and actor identity are absent from logs, screenshots and fixtures.

## Handoff

- Rollback / recovery:
- Evidence or screenshots:
- [ ] Claude Code reviewed the final diff before merge to `main`.
