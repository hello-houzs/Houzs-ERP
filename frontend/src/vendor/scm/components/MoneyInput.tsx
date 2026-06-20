// ----------------------------------------------------------------------------
// MoneyInput — edit a sen/centi integer as an RM amount.
//
// Commander 2026-05-29: the old price cells used <input type="number"> with a
// controlled string that re-synced on every parent render — so a react-query
// refetch mid-edit clobbered what you typed, and you couldn't just clear the
// field and retype (the "10 jumps to the front" bug). The PO/PI/PR FORMS had a
// worse variant: <input type="number" value={(centi/100).toFixed(2)}> reformat
// on every keystroke, so typing "500" only registered "5" ("我放了 500 却不行,
// 只能识别到 5"). This fixes both:
//   • type="text" + inputMode="decimal" → no number-input cursor/format quirks
//   • free typing while focused; the value only re-syncs from upstream when the
//     field is NOT focused
//   • onChange accepts an empty string + up to 2 decimals (clear & retype works)
//   • parse + normalise only on blur / Enter; Esc reverts
//
// Two render modes:
//   • default → inline RM editor (span wrapper + "RM" prefix, ~84px) for table
//     cells (SupplierDetail price matrix).
//   • bare    → just the <input>, styled by `inputClassName` + `style`, for the
//     full-width form fields (New PO / PI / Purchase Return line editors).
// Reusable everywhere money is edited so the whole system behaves the same way.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import styles from './MoneyInput.module.css';

const fmt = (sen: number | null | undefined): string =>
  sen == null ? '' : (sen / 100).toFixed(2);

export const MoneyInput = ({
  valueSen,
  onCommit,
  currency = 'RM',
  allowBlank = false,
  placeholder = '—',
  className,
  title,
  // Bare mode (form fields): render just the input, no wrapper / no currency.
  bare = false,
  inputClassName,
  style,
  align = 'right',
  selectOnFocus = false,
  disabled = false,
}: {
  valueSen: number | null;
  /** Called with the new sen value (or null when cleared, if allowBlank). */
  onCommit: (sen: number | null) => void;
  currency?: string;
  allowBlank?: boolean;
  placeholder?: string;
  className?: string;
  title?: string;
  /** Render only the <input> (no span wrapper / currency prefix). */
  bare?: boolean;
  /** Class applied to the <input> in bare mode (e.g. styles.fieldInput). */
  inputClassName?: string;
  style?: CSSProperties;
  align?: 'left' | 'right';
  /** Select-all on focus so a default like "1.00" is overwritten in one go. */
  selectOnFocus?: boolean;
  disabled?: boolean;
}) => {
  const [draft, setDraft] = useState(() => fmt(valueSen));
  const focused = useRef(false);

  // Re-sync from upstream ONLY when the user isn't actively editing — so a
  // background refetch / auto-fill never overwrites in-progress typing.
  useEffect(() => {
    if (!focused.current) setDraft(fmt(valueSen));
  }, [valueSen]);

  const commit = () => {
    const t = draft.trim();
    if (t === '' || t === '.') {
      if (allowBlank) { if (valueSen != null) onCommit(null); }
      else setDraft(fmt(valueSen));
      return;
    }
    const next = Math.round(Number(t) * 100);
    if (!Number.isFinite(next) || next < 0) { setDraft(fmt(valueSen)); return; }
    if (next !== valueSen) onCommit(next);
    setDraft(fmt(next)); // normalise (e.g. "550" → "550.00")
  };

  const inputEl = (
    <input
      type="text"
      inputMode="decimal"
      className={bare ? (inputClassName ?? styles.input) : styles.input}
      style={bare ? { textAlign: align, ...style } : style}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      title={title ?? 'Click to edit · Enter to save · Esc to cancel'}
      onFocus={(e) => { focused.current = true; if (selectOnFocus) e.currentTarget.select(); }}
      onChange={(e) => {
        const v = e.target.value;
        // empty, or digits with up to 2 decimals — lets you clear & retype.
        if (v === '' || /^\d*\.?\d{0,2}$/.test(v)) setDraft(v);
      }}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(fmt(valueSen)); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );

  if (bare) return inputEl;

  return (
    <span className={`${styles.wrap} ${className ?? ''}`}>
      {currency && <span className={styles.currency}>{currency}</span>}
      {inputEl}
    </span>
  );
};
