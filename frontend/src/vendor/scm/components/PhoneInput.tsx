// PhoneInput — country-selectable phone field (request 2026-06-05:
// "电话号码 +60 格式可以选择国家，默认马来西亚").
//
// A country dial-code dropdown (defaults to Malaysia +60) + a national-number
// input. The parent state always holds the canonical E.164 storage form
// ("+60116155633") via onChange, so submission to the API is already correct
// and the API's defensive normalizePhone keeps any explicit country code.
// The shared country list + split/combine helpers live in @2990s/shared/phone,
// so the Backend and the POS share the exact same behaviour.
//
// Replaces the previous Malaysia-only pretty-formatter. Same props, so every
// existing call site (Sales Order, Delivery, Consignment, Suppliers, Settings,
// CustomerCard, EmergencyContactCard, …) upgrades with no per-site change.

import { useEffect, useRef, useState } from 'react';
import { COUNTRY_DIAL_CODES, splitE164, combineE164 } from '@2990s/shared/phone';

type PhoneInputProps = {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  'aria-label'?: string;
};

export const PhoneInput = ({
  value,
  onChange,
  className,
  placeholder = '11-6155 6133',
  disabled,
  required,
  id,
  'aria-label': ariaLabel,
}: PhoneInputProps) => {
  const init = splitE164(value);
  const [dial, setDial] = useState(init.dial);
  const [national, setNational] = useState(init.national);
  const lastSynced = useRef(value);

  // Pull external value changes (a fresh row loads) into local state, without
  // clobbering an in-progress edit (which updates lastSynced on every emit).
  useEffect(() => {
    if (lastSynced.current !== value) {
      const p = splitE164(value);
      setDial(p.dial);
      setNational(p.national);
      lastSynced.current = value;
    }
  }, [value]);

  const emit = (d: string, n: string) => {
    const next = combineE164(d, n);
    lastSynced.current = next;
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch', minWidth: 0 }}>
      <select
        aria-label="Country dial code"
        disabled={disabled}
        value={dial}
        onChange={(e) => { setDial(e.target.value); emit(e.target.value, national); }}
        className={className}
        style={{ flex: '0 0 auto', width: 96, cursor: disabled ? 'default' : 'pointer' }}
      >
        {COUNTRY_DIAL_CODES.map((c) => (
          <option key={c.iso} value={c.dial}>{c.flag} +{c.dial}</option>
        ))}
      </select>
      <input
        type="tel"
        id={id}
        className={className}
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        value={national}
        onChange={(e) => {
          let n = e.target.value.replace(/\D+/g, '');
          // Dedup a leading dial-code inside the national digits (owner
          // sighting 2026-07-22: operator typed "601161556133" with MY +60
          // selected → stored "+60601161556133", a double country code that
          // makes the number invalid). splitE164 already applies the same
          // strip on the read path; the write path was missing it.
          if (dial && n.startsWith(dial)) n = n.slice(dial.length);
          setNational(n);
          emit(dial, n);
        }}
        style={{ flex: 1, minWidth: 0 }}
      />
    </div>
  );
};
