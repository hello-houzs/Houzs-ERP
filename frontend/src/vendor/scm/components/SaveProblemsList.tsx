// ----------------------------------------------------------------------------
// SaveProblemsList — renders the backend's aggregated save-gate failures
// (validation_failed → problems[]) as a list inside a NotifyDialog popup, one
// row per problem, each naming its concrete line + field.
//
// Owner 2026-07-18: setting a Processing Date / saving a confirmed SO used to
// fail ONE gate at a time (fix, save, hit the next). The backend now reports
// every reason at once; this is the ONE renderer both desktop (SalesOrderDetail)
// and mobile (MobileNewSO) hand to `notify({ body: <SaveProblemsList …> })`, so
// the two surfaces list them identically.
//
// Left-aligned because NotifyDialog centres its body text by default and a
// bulleted list must read as a list.
// ----------------------------------------------------------------------------
import type { SaveProblem } from '../lib/authed-fetch';

export function SaveProblemsList({ problems }: { problems: SaveProblem[] }) {
  return (
    <ul style={{ textAlign: 'left', margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.5 }}>
      {problems.map((p, i) => (
        <li key={`${p.code}-${p.line ?? ''}-${p.field ?? ''}-${i}`}>{p.message}</li>
      ))}
    </ul>
  );
}

/** The popup title for an aggregated save failure — singular / plural by count. */
export function saveProblemsTitle(count: number): string {
  return count === 1
    ? 'This needs fixing before saving'
    : `${count} things need fixing before saving`;
}
