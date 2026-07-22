import { describe, expect, it } from 'vitest';
import { humanApiError } from './authed-fetch';

describe('SO header version failures', () => {
  it('explains a conflict without implying that the unsaved input was discarded', () => {
    const message = humanApiError(409, JSON.stringify({
      error: 'so_version_conflict',
      currentVersion: 4,
    }));

    expect(message).toMatch(/someone else updated/i);
    expect(message).toMatch(/changes are still on this screen/i);
    expect(message).toMatch(/refresh/i);
    expect(message).not.toMatch(/409|currentVersion|so_version_conflict/);
  });

  it('turns a stale pre-version client into a recoverable 428 instruction', () => {
    const message = humanApiError(428, JSON.stringify({
      error: 'so_version_required',
      currentVersion: 2,
    }));

    expect(message).toMatch(/older screen/i);
    expect(message).toMatch(/changes are still here/i);
    expect(message).toMatch(/refresh/i);
    expect(message).not.toMatch(/428|currentVersion|so_version_required/);
  });

  it('keeps lease contention recoverable without exposing the lease protocol', () => {
    const message = humanApiError(409, JSON.stringify({ error: 'so_edit_lease_conflict' }));

    expect(message).toMatch(/another screen/i);
    expect(message).toMatch(/changes are still here/i);
    expect(message).toMatch(/try save again/i);
    expect(message).not.toMatch(/409|lease|so_edit_lease_conflict/);
  });
});
