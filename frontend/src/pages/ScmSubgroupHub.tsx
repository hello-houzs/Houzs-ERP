import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { HubGrid, type HubCard } from "../components/HubGrid";
import { useAuth } from "../auth/AuthContext";

/**
 * Generic Level 2 hub for a Supply Chain sub-group — Nick 2026-07-09:
 *   "这些也需要做成这样的页面 - 和 project"
 *
 * Drops the operator on a landing page mirroring /projects?view=hub:
 * an eyebrow + title + description, then a card grid of the group's
 * child modules. Driven off NAV_TABS (single source of truth shared
 * with the Sidebar) so adding / removing a leaf under the sub-group
 * lists it here automatically — same permission filter (perm /
 * anyPerm / anyAccess / pageAccess) as ScmHub so an operator only
 * sees the cards they can actually reach.
 *
 * Mounted per sub-group by App.tsx with a static `groupId` prop:
 *   /scm/sales-order    → groupId="scm-sales"
 *   /scm/consignment    → groupId="scm-consignment"
 *   /scm/procurement    → groupId="scm-procurement"
 *   /scm/transportation → groupId="scm-transportation"
 *   /scm/warehouse      → groupId="scm-warehouse"
 *   /scm/finance        → groupId="scm-finance"
 */
export function ScmSubgroupHub({
  groupId,
  description,
}: {
  groupId: string;
  /** One-line landing pitch shown under the title. Kept as a prop so each
   *  sub-group can tune the copy without a NAV_TABS churn. */
  description: string;
}) {
  const navigate = useNavigate();
  const { can, pageAccess } = useAuth();

  // Same visibility filter ScmHub uses so the two hubs never drift.
  const visible = (t: NavTab): boolean => {
    if (t.perm && !can(t.perm)) return false;
    if (t.anyPerm || t.anyAccess) {
      const permOk = t.anyPerm ? t.anyPerm.some((p) => can(p)) : false;
      const accessOk = t.anyAccess
        ? t.anyAccess.some((k) => pageAccess(k) !== "none")
        : false;
      if (!permOk && !accessOk) return false;
    }
    if (t.hidePerm && can(t.hidePerm)) return false;
    if (t.pageAccess && pageAccess(t.pageAccess) === "none") return false;
    if (t.pageAccessFull && pageAccess(t.pageAccessFull) !== "full") return false;
    return true;
  };

  const scm = NAV_TABS.find((t) => t.groupId === "scm");
  const group = scm?.children?.find((g) => g.groupId === groupId);
  const kids = (group?.children ?? []).filter(visible);

  // Empty state — a role with SCM access but no leaves inside this specific
  // sub-group (e.g. warehouse without inventory / stock take). Better than a
  // blank grid.
  if (!group) {
    return (
      <div>
        <PageHeader
          eyebrow="Operations · Supply Chain"
          title="Not found"
          description="This section doesn't exist."
        />
      </div>
    );
  }

  const cards: HubCard[] = kids
    .filter((k): k is NavTab & { to: string } => Boolean(k.to))
    .map((k) => ({
      key: k.to,
      label: k.label,
      icon: k.icon,
      onClick: () => navigate(k.to),
    }));

  return (
    <div>
      <PageHeader
        eyebrow={`Operations · Supply Chain · ${group.label}`}
        title={group.label}
        description={description}
      />
      {cards.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-[12px] text-ink-muted shadow-stone">
          You don't have access to any {group.label.toLowerCase()} modules yet.
        </div>
      ) : (
        <HubGrid cards={cards} />
      )}
    </div>
  );
}
