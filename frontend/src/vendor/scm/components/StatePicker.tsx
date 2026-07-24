// ----------------------------------------------------------------------------
// StatePicker — the ONE canonical state dropdown for every address surface.
//
// Owner directive 2026-07-24 (task #102): one consistent, clean state selector
// everywhere — no ad-hoc free-text state entry.
//   • States are ALWAYS GROUPED BY COUNTRY in native <optgroup>s. Malaysia (the
//     primary market) lists first, then every other seeded country
//     alphabetically, with any country-less state under "Other".
//   • Type-to-search FILTERS the grouped list (desktop). It only narrows the
//     seeded options; it can NEVER introduce a new value.
//   • The legacy "Others" expander and the free-text "Search" escape are GONE.
//     Both were backdoors — the first hid CN/SG behind an extra click, the
//     second let an operator commit a state that isn't in scm.my_localities.
//
// TWO layouts, driven by the `country` prop:
//   • Country pinned (Warehouse / Supplier edit — country is a separate field)
//     → a flat <select> of just that country's states.
//   • Country empty (create-supplier / Venue / SO forms) → the grouped-by-country
//     <select>.
//   Both desktop layouts sit under a visible type-to-search box; only `compact`
//   (mobile, native OS picker) is select-only.
//
// STYLING: the default select + search box are bordered to match the sibling
// City / Country / Postcode selects (see StatePicker.module.css) — the owner's
// 2026-07-24 fix for the picker reading as a bare borderless control. A caller
// may still pass `selectClassName` (e.g. mobile "fld-i") to restyle the select.
//
// The value MUST live in scm.my_localities. While the seed is loading or empty
// the control stays DISABLED ("Loading…" / "No states seeded") — never a
// free-text input, which is the exact pattern this component removes. A stored
// value that isn't in the seeded set is still shown as the current selection so
// old data never blanks; it just isn't offered as a fresh option — pick a
// seeded state, or add the missing one via the Localities Maintenance UI.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import {
  useLocalities,
  statesInCountry,
  countryForState,
  distinctStates,
} from '../lib/localities-queries';
import styles from './StatePicker.module.css';

const PRIMARY_COUNTRY = 'Malaysia' as const;
const UNGROUPED = 'Other' as const;

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
  /** When set, restrict the picker to this country's states (flat list).
   *  When empty, show every seeded state grouped by country. */
  country?: string;
  value: string;
  /** derivedCountry is the state's country from my_localities — the caller can
   *  patch its own Country field if it was blank. Null if unknown. */
  onChange: (nextState: string, derivedCountry: string | null) => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  /** Compact — render ONLY the grouped <select> (no search box). For mobile /
   *  tight inline contexts where the native optgroup picker already groups by
   *  country (iOS wheel, Android list). Grouping keeps MY on top so the owner's
   *  "MY first" spirit survives. */
  compact?: boolean;
  /** Applied to the inner <select> so the caller can share its form styles. */
  selectClassName?: string;
}) => {
  const localities = useLocalities();
  const rows = localities.data ?? [];
  const [query, setQuery] = useState('');
  const isCountryPinned = country.trim().length > 0;

  /* Country-pinned: a flat list of that country's states.
     Country-empty: states bucketed by country, MY first, "Other" last. */
  const scoped = useMemo(
    () => (isCountryPinned ? statesInCountry(rows, country) : []),
    [rows, country, isCountryPinned],
  );
  const orderedGroups = useMemo<[string, string[]][]>(() => {
    if (isCountryPinned) return [];
    const byCountry = new Map<string, string[]>();
    for (const s of distinctStates(rows)) {
      const c = countryForState(rows, s) ?? UNGROUPED;
      const arr = byCountry.get(c);
      if (arr) arr.push(s);
      else byCountry.set(c, [s]);
    }
    // MY first, then every other country A→Z, "Other" (country-less) last.
    return Array.from(byCountry.entries()).sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === PRIMARY_COUNTRY) return -1;
      if (b === PRIMARY_COUNTRY) return 1;
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
  }, [rows, isCountryPinned]);

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);

  /* Is the stored value one of the seeded states? If not (legacy data, or a
     state whose country differs from a now-pinned one), it is still shown as the
     current selection below so it never blanks. */
  const knownStates = useMemo(
    () => new Set(isCountryPinned ? scoped : distinctStates(rows)),
    [isCountryPinned, scoped, rows],
  );
  const orphanValue = value.trim().length > 0 && !knownStates.has(value);

  const handlePick = (nextState: string) => {
    if (!nextState) {
      onChange('', null);
      return;
    }
    const derived = countryForState(rows, nextState);
    onChange(nextState, derived);
  };

  /* Loading / empty locality set: keep the dropdown DISABLED rather than falling
     back to free text. Empty = pre-seed environment; loading = fetch in flight.
     Either way, letting the operator type a raw string is the backdoor this
     component exists to remove. */
  const isEmpty = !localities.isLoading && rows.length === 0;
  const controlsDisabled = disabled || localities.isLoading || isEmpty;

  const selectEl = (
    <select
      value={value}
      onChange={(e) => handlePick(e.target.value)}
      disabled={controlsDisabled}
      className={selectClassName ?? styles.select}
    >
      <option value="">
        {localities.isLoading ? 'Loading…' : isEmpty ? 'No states seeded' : placeholder}
      </option>
      {/* Stored value not in the seed — shown so old data never blanks. Not
          grouped (it isn't a maintained state); picking a real one replaces it. */}
      {orphanValue && <option value={value}>{value}</option>}
      {isCountryPinned
        ? scoped.filter(match).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))
        : orderedGroups.map(([c, list]) => {
            const opts = list.filter(match);
            if (opts.length === 0) return null;
            return (
              <optgroup key={c} label={c}>
                {opts.map((s) => (
                  <option key={`${c}-${s}`} value={s}>{s}</option>
                ))}
              </optgroup>
            );
          })}
    </select>
  );

  const wrapCls = className ? `${styles.wrap} ${className}` : styles.wrap;

  /* Compact (mobile native picker) is select-only. Every desktop layout —
     country-pinned AND country-empty — carries the type-to-search box above
     the select, so the search is consistently visible on every surface. */
  if (compact) {
    return <div className={wrapCls} style={style}>{selectEl}</div>;
  }

  return (
    <div className={wrapCls} style={style}>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search state…"
        disabled={controlsDisabled}
        className={styles.search}
      />
      {selectEl}
    </div>
  );
};
