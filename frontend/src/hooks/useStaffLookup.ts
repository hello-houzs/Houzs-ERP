// useStaffLookup — one-liner id→name lookup for the SCM V2 lists.
//
// The manufacture-side list endpoints (mfg-sales-orders, mfg-delivery-orders,
// sales-invoices, delivery-returns) return `salesperson_id` as a raw UUID
// but no friendly name. Rendering the UUID directly reads as gibberish
// (2026-07-08 bug report). This hook fetches the /staff roster (cached
// 10 min) and returns a helper that:
//   · returns `agent` verbatim when set (some rows carry a text `agent`),
//   · else looks up `salesperson_id` → `name` (or `staffCode` if the row
//     has no display name),
//   · else returns `fallback` (default "—") — NEVER a UUID.

import { useMemo } from "react";
import { useStaff } from "../vendor/scm/lib/admin-queries";

export function useStaffLookup() {
  const staffQ = useStaff();
  return useMemo(() => {
    const byId = new Map<string, string>();
    for (const s of staffQ.data ?? []) {
      if (s.id) byId.set(s.id, s.name || s.staffCode || "");
    }
    const nameOf = (
      agent: string | null | undefined,
      salespersonId: string | null | undefined,
      fallback = "—"
    ): string => {
      if (agent && agent.trim()) return agent;
      if (salespersonId) {
        const looked = byId.get(salespersonId);
        if (looked && looked.trim()) return looked;
      }
      return fallback;
    };
    return { nameOf, byId, isLoading: staffQ.isLoading };
  }, [staffQ.data, staffQ.isLoading]);
}
