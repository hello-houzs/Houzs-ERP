// Reusable hook for persisting column visibility + order to localStorage.
// Pattern matches DashboardPage column management exactly.

import { useEffect, useState } from "react";

export interface UseColumnPrefsResult {
  order: string[];
  hidden: Set<string>;
  setOrder: React.Dispatch<React.SetStateAction<string[]>>;
  setHidden: React.Dispatch<React.SetStateAction<Set<string>>>;
  resetColumns: () => void;
}

export function useColumnPrefs(
  storageKey: string,
  defaultOrder: string[],
  defaultHidden: string[],
  /** Earlier-version keys to migrate from if current key is empty (preserves user customization across version bumps) */
  legacyKeys: string[] = [],
): UseColumnPrefsResult {
  const [order, setOrder] = useState<string[]>(defaultOrder);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(defaultHidden));

  // Restore on mount (with legacy-key migration)
  useEffect(() => {
    try {
      let raw = localStorage.getItem(storageKey);
      // Try each legacy key in order — first hit wins, gets copied forward
      if (!raw) {
        for (const lk of legacyKeys) {
          const old = localStorage.getItem(lk);
          if (old) { raw = old; localStorage.setItem(storageKey, old); break; }
        }
      }
      if (raw) {
        const parsed = JSON.parse(raw) as { order?: string[]; hidden?: string[] };
        if (Array.isArray(parsed.order)) {
          const known = new Set(parsed.order);
          const merged = [...parsed.order.filter((k: string) => defaultOrder.includes(k))];
          for (const k of defaultOrder) if (!known.has(k)) merged.push(k);
          setOrder(merged);
        }
        if (Array.isArray(parsed.hidden)) setHidden(new Set(parsed.hidden));
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on change
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ order, hidden: [...hidden] }));
    } catch { /* ignore */ }
  }, [order, hidden, storageKey]);

  function resetColumns() {
    setOrder(defaultOrder);
    setHidden(new Set(defaultHidden));
  }

  return { order, hidden, setOrder, setHidden, resetColumns };
}
