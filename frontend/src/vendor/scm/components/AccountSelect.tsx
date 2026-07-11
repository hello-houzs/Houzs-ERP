// ----------------------------------------------------------------------------
// AccountSelect — a chart-of-accounts <select>, grouped by account type, used
// by the Payment Voucher pages to pick a GL account (the "Paid From" credit
// account on the header + the expense/charge debit account per line).
//
// HOUZS VENDOR — verbatim port of 2990's apps/backend/src/components/AccountSelect.tsx.
// Only the Account type import boundary changed (→ the vendored accounting-queries).
//
// Options show "<code> · <name>" and are grouped into ASSET / LIABILITY /
// EQUITY / INCOME / EXPENSE optgroups so a long chart stays scannable. Pure
// presentational — the caller passes the already-loaded + filtered accounts
// (see useAccounts) and owns the value.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import type { Account } from '../lib/accounting-queries';

const TYPE_ORDER: Account['account_type'][] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const TYPE_LABEL: Record<Account['account_type'], string> = {
  ASSET:     'Assets',
  LIABILITY: 'Liabilities',
  EQUITY:    'Equity',
  INCOME:    'Income',
  EXPENSE:   'Expenses',
};

export function AccountSelect({
  accounts,
  value,
  onChange,
  className,
  placeholder = '— Select an account —',
  disabled,
}: {
  accounts: Account[];
  value: string;
  onChange: (accountCode: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const grouped = useMemo(() => {
    const by = new Map<Account['account_type'], Account[]>();
    for (const a of accounts) {
      const list = by.get(a.account_type) ?? [];
      list.push(a);
      by.set(a.account_type, list);
    }
    for (const list of by.values()) list.sort((x, y) => x.account_code.localeCompare(y.account_code));
    return by;
  }, [accounts]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      disabled={disabled}
    >
      <option value="">{placeholder}</option>
      {TYPE_ORDER.filter((t) => (grouped.get(t)?.length ?? 0) > 0).map((t) => (
        <optgroup key={t} label={TYPE_LABEL[t]}>
          {(grouped.get(t) ?? []).map((a) => (
            <option key={a.account_code} value={a.account_code}>
              {a.account_code} · {a.account_name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
