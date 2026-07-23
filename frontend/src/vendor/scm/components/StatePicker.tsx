// ----------------------------------------------------------------------------
// StatePicker — canonical state dropdown across MY + CN + SG.
//
// Owner directive 2026-07-23 (after finding my `(legacy)` sneak-through in
// #1054/#1058/#1059):
//   "1. 默认设置(By default): 只显示马来西亚的 state.
//    2. 查看其它地区: 如果要看到中国和新加坡的 state, 用户需要点击 Others 才会跳出来.
//    3. 搜索功能: 用户可以通过 Search 功能直接搜索并打出这些 state."
//
// TWO MODES driven by the `country` prop:
//   • Country pinned (Warehouse / Supplier form — country is picked separately)
//     → plain <select> filtered to that country's states. No Others toggle,
//       no search overlay — the country picker already narrowed the scope.
//   • Country empty (Venue form, or any surface where State is picked before
//     Country)
//     → search input + <select> with Malaysia states listed by default and
//       an "Others" button that expands to show China + Singapore states.
//       Typing in the search box auto-expands Others and filters every
//       state across all three countries.
//
// State value MUST be in scm.my_localities — no `(legacy)` fallback option
// (that was the backdoor). If the current stored value isn't in the seeded
// set, the <select> renders it as "— pick state —" instead of preserving
// an unmaintained string. The operator is forced to pick a legit state, or
// go add the missing state via the Localities Maintenance UI.
//
// NEVER a free-text fallback. If localities is loading or the seed is
// empty (cold-start / new environment before mig 0181 runs), the dropdown
// stays disabled with "Loading…" — writing an arbitrary state through a
// text input is exactly the pattern this component exists to remove.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import {
  useLocalities,
  statesInCountry,
  countryForState,
  distinctStates,
} from '../lib/localities-queries';

const PRIMARY_COUNTRY = 'Malaysia' as const;

export const StatePicker = ({
  country = '',
  value,
  onChange,
  className,
  style,
  disabled,
  placeholder = '— pick state —',
  compact = false,
  selectClassName,
}: {
  /** When set, restrict the picker to this country's states (no Others toggle).
   *  When empty, default to Malaysia + Others expander for CN/SG. */
  country?: string;
  value: string;
  /** derivedCountry is the state's country from my_localities — the caller
   *  can patch its own Country field if it was blank. Null if unknown. */
  onChange: (nextState: string, derivedCountry: string | null) => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  /** Compact mode — render ONLY the <select> with MY / Others <optgroup>s
   *  (no search input, no Show-Others button). For mobile / tight inline
   *  contexts where the native select+optgroup already gives an OS-level
   *  grouped picker (iOS wheel picker, Android list). Grouping still keeps
   *  MY on top so the owner's "MY default" spirit survives. */
  compact?: boolean;
  /** Applied to the inner <select> so the caller can share its form styles. */
  selectClassName?: string;
}) => {
  const localities = useLocalities();
  const rows = localities.data ?? [];
  const [showOthers, setShowOthers] = useState(false);
  const [query, setQuery] = useState('');
  const isCountryPinned = country.trim().length > 0;

  /* Country-pinned view: single flat list of that country's states.
     Country-empty view: pre-computed MY / Others buckets. */
  const scoped = useMemo(
    () => (isCountryPinned ? statesInCountry(rows, country) : []),
    [rows, country, isCountryPinned],
  );
  const groups = useMemo(() => {
    if (isCountryPinned) return null;
    const my = statesInCountry(rows, PRIMARY_COUNTRY);
    const others = distinctStates(rows).filter((s) => !my.includes(s));
    // Bucket Others by country so the <optgroup> labels stay legible.
    const byCountry = new Map<string, string[]>();
    for (const s of others) {
      const c = countryForState(rows, s) ?? 'Other';
      const arr = byCountry.get(c) ?? [];
      arr.push(s);
      byCountry.set(c, arr);
    }
    return { my, byCountry };
  }, [rows, isCountryPinned]);

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);

  /* Search auto-expands Others so a match under China/Singapore is visible
     without a second click. */
  const showOthersEffective = showOthers || q.length > 0;

  const handlePick = (nextState: string) => {
    if (!nextState) {
      onChange('', null);
      return;
    }
    const derived = countryForState(rows, nextState);
    onChange(nextState, derived);
  };

  /* Loading / empty locality set: keep the dropdown DISABLED rather than
     falling back to free text. Empty = pre-seed environment; loading = the
     data fetch is in flight. Either way, letting the operator type a raw
     string is the exact backdoor this component removes. */
  const isEmpty =
    !localities.isLoading && rows.length === 0;
  const controlsDisabled = disabled || localities.isLoading || isEmpty;

  /* Compact mode always shows every optgroup (MY on top, then Others by
     country). The native OS picker groups them for tapping — no search input
     / expand button needed. Full mode keeps the desktop UX (MY-default with
     Others toggle + search box). */
  const alwaysShowOthers = compact;
  const showOthersRendered = compact || showOthersEffective;

  const selectEl = (
    <select
      value={value}
      onChange={(e) => handlePick(e.target.value)}
      disabled={controlsDisabled}
      className={selectClassName}
      style={selectClassName ? undefined : { width: '100%', padding: '6px 8px', boxSizing: 'border-box' }}
    >
      <option value="">
        {localities.isLoading ? 'Loading…' : isEmpty ? 'No states seeded' : placeholder}
      </option>
      {isCountryPinned ? (
        scoped.filter(match).map((s) => (
          <option key={s} value={s}>{s}</option>
        ))
      ) : (
        <>
          <optgroup label={PRIMARY_COUNTRY}>
            {groups!.my.filter(match).map((s) => (
              <option key={`my-${s}`} value={s}>{s}</option>
            ))}
          </optgroup>
          {showOthersRendered &&
            Array.from(groups!.byCountry.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([c, list]) => (
                <optgroup key={c} label={c}>
                  {list.filter(match).map((s) => (
                    <option key={`${c}-${s}`} value={s}>{s}</option>
                  ))}
                </optgroup>
              ))}
        </>
      )}
    </select>
  );

  if (compact) {
    return <div className={className} style={style}>{selectEl}</div>;
  }

  return (
    <div className={className} style={style}>
      {!isCountryPinned && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search state…"
          disabled={controlsDisabled}
          style={{ width: '100%', marginBottom: 6, padding: '6px 8px', boxSizing: 'border-box' }}
        />
      )}
      {selectEl}
      {!isCountryPinned && !q && !alwaysShowOthers && (
        <button
          type="button"
          onClick={() => setShowOthers((v) => !v)}
          disabled={controlsDisabled}
          style={{
            marginTop: 6,
            padding: '4px 8px',
            fontSize: 12,
            background: 'transparent',
            border: '1px solid var(--line, #ccc)',
            borderRadius: 4,
            cursor: controlsDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          {showOthers ? '▲ Hide Others' : '▼ Show Others (China / Singapore)'}
        </button>
      )}
    </div>
  );
};
