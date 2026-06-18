// ─────────────────────────────────────────────────────────────────────────
// staff-code.ts — auto-generation of staff_code + initials for new staff.
//
// staff_code continues the existing "2990S-NNN" series (3-digit). Pure here;
// the caller queries existing codes and handles the (rare) UNIQUE-violation
// retry on insert. initials are derived from the name for the avatar chip.
// ─────────────────────────────────────────────────────────────────────────

const STAFF_CODE_RE = /^2990S-(\d+)$/;

/** Next "2990S-NNN" given the existing staff_code values (any shape). */
export function nextStaffCode(existing: ReadonlyArray<string | null | undefined>): string {
  let max = 0;
  for (const code of existing) {
    if (!code) continue;
    const m = STAFF_CODE_RE.exec(code);
    if (m) max = Math.max(max, parseInt(m[1] ?? '0', 10));
  }
  return `2990S-${String(max + 1).padStart(3, '0')}`;
}

/** Avatar initials from a name: first letter of each word, uppercased, ≤4. */
export function extractInitials(name: string): string {
  const out = name
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 4);
  return out || 'X';
}
