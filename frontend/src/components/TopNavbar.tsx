import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Check, ChevronRight, ChevronsUpDown } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useBreadcrumbs } from "../hooks/useBreadcrumbs";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import { PresenceIndicator } from "./PresenceIndicator";
import { Avatar } from "./Avatar";
import { cn } from "../lib/utils";
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { useDialog } from "../hooks/useDialog";
import {
  getActiveCompanySnapshot,
  setActiveCompanyId,
  subscribeActiveCompany,
} from "../lib/activeCompany";
import { clearAllScmHandoffs } from "../lib/scmHandoffStorage";

/**
 * Desktop-only sticky top navbar. Hosts breadcrumb (left), search +
 * notifications + profile avatar (right). Hidden below lg; the mobile
 * top bar in Layout owns its own reduced chrome.
 *
 * Breadcrumb source of truth: BreadcrumbContext. DetailLayout pushes
 * its crumbs via useSetBreadcrumbs; for plain list pages we fall back
 * to a route-derived single crumb.
 */
export function TopNavbar() {
  const { user } = useAuth();
  const { crumbs } = useBreadcrumbs();
  const location = useLocation();

  // When the active page hasn't set its own breadcrumb, build a
  // single-crumb label from the current route so the navbar never
  // looks empty.
  const shown =
    crumbs.length > 0 ? crumbs : [{ label: labelForPath(location.pathname) }];

  return (
    <header className="sticky top-0 z-30 hidden h-12 items-center gap-3 border-b border-border bg-surface/95 px-5 backdrop-blur-sm lg:flex">
      {/* ── Breadcrumb ───────────────────────────────────────── */}
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[12px]"
      >
        {shown.map((item, i) => {
          const isLast = i === shown.length - 1;
          return (
            <Fragment key={`${item.label}-${i}`}>
              {i > 0 && (
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className="shrink-0 text-ink-muted/50"
                />
              )}
              {item.to && !isLast ? (
                <Link
                  to={item.to}
                  className="shrink-0 truncate rounded px-1 py-0.5 font-medium text-ink-secondary transition-colors hover:bg-bg/60 hover:text-accent"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className={cn(
                    "min-w-0 truncate px-1 py-0.5",
                    // Current page reads petrol — matches the design's
                    // breadcrumb (last crumb #16695f/600).
                    isLast ? "font-semibold text-primary" : "text-ink-secondary"
                  )}
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
            </Fragment>
          );
        })}
      </nav>

      {/* ── Right rail: company · search · online · bell · profile ───── */}
      <div className="flex shrink-0 items-center gap-2">
        <CompanySwitcher />
        <GlobalSearchTrigger collapsed={false} />
        {user && (
          <>
            <PresenceIndicator />
            <NotificationBell collapsed direction="down" align="end" />
            <NavLink
              to="/profile"
              className="group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-bg/60"
              title={`${user.name || user.email} — Profile`}
              aria-label="Profile"
            >
              <Avatar
                userId={user.id}
                hasImage={user.profile_pic_r2_key}
                name={user.name}
                email={user.email}
                size={28}
              />
              <div className="hidden min-w-0 xl:block">
                <div className="truncate text-[11.5px] font-semibold text-ink group-hover:text-accent">
                  {user.name || user.email.split("@")[0]}
                </div>
                <div className="truncate text-[9.5px] text-ink-muted">
                  {user.role_name}
                </div>
              </div>
            </NavLink>
          </>
        )}
      </div>
    </header>
  );
}

// ── Company switcher ───────────────────────────────────────
// Multi-company (Phase 0c). Fetches GET /api/companies and renders a compact
// dropdown of the active company's name. NO-OP by design: renders NOTHING until
// the companies master exists and returns MORE THAN ONE company — so today
// (single-company Houzs) it is invisible and no X-Company-Id header is sent.
// Selecting a company writes the active-company store (persisted to
// localStorage) and invalidates every query so the whole app refetches scoped
// to the new company. Styling reuses the navbar's Ink & Petrol tokens.

interface CompaniesResponse {
  companies: Array<{ id: number; code: string; name: string }>;
  activeCompanyId: number | null;
  activeCompanyCode: string | null;
}

function CompanySwitcher() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dialog = useDialog();

  // Persisted switcher pick (null = follow the backend hostname default).
  const stored = useSyncExternalStore(
    subscribeActiveCompany,
    getActiveCompanySnapshot,
    getActiveCompanySnapshot,
  );

  const { data } = useQuery<CompaniesResponse>("/api/companies",
    () => api.get<CompaniesResponse>("/api/companies"),
    [],
  );
  const companies = data?.companies ?? [];

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  // No-op: hidden entirely until there is a real choice to make.
  if (companies.length <= 1) return null;

  // Active = the stored pick when it's still a valid company, else the backend's
  // resolved active (hostname default), else the first company.
  const activeId =
    (stored && companies.some((co) => co.id === stored) ? stored : null) ??
    data?.activeCompanyId ??
    companies[0]?.id ??
    null;
  const active = companies.find((co) => co.id === activeId) ?? companies[0];

  async function pick(id: number) {
    setOpen(false);
    if (id === activeId) return;
    // The switch below hard-reloads the whole app (see the block comment) to
    // guarantee zero cross-company staleness — but a reload silently discards
    // any unsaved edits: the app registers no beforeunload guard, so nothing
    // else warns the user. Confirm first so a mid-edit switch can't lose work.
    // Only reached when the target company actually differs (same-company
    // re-selects already returned above), so we never nag on a no-op pick.
    const ok = await dialog.confirm({
      title: "Switch company?",
      message:
        "Switching company reloads the page — any unsaved changes will be lost. Continue?",
      confirmLabel: "Switch company",
    });
    if (!ok) return;
    // A company switch is a fundamental tenant-context change. Backend scoping
    // already isolates each company's data (companyContext + X-Company-Id); the
    // frontend must never leave the previous company's rows on screen for even
    // one frame. In-place cache invalidation could not guarantee that: react-query
    // keys don't include the company, invalidateQueries raced, and
    // queryClient.clear() empties the cache but does NOT re-trigger a mounted
    // observer to refetch — so a list kept showing the previous company until it
    // happened to remount. A full page reload is the bulletproof fix: nothing
    // stale can render because the whole app re-boots. We persist the new active
    // company to localStorage FIRST (setActiveCompanyId is a synchronous
    // localStorage write), so after the reload the app boots under the new company
    // and every request carries the new X-Company-Id header. Company switches are
    // rare + deliberate, so the reload cost is an acceptable trade for guaranteed
    // zero cross-company staleness.
    clearAllScmHandoffs();
    setActiveCompanyId(id);
    window.location.reload();
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-bg/40 px-2 py-1 text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-bg/60 hover:text-accent"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch company"
      >
        <span className="max-w-[9rem] truncate">{active?.name ?? "Company"}</span>
        <ChevronsUpDown size={13} strokeWidth={2} className="shrink-0 text-ink-muted/70" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-40 mt-1 min-w-[13rem] overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {companies.map((co) => {
            const isActive = co.id === activeId;
            return (
              <button
                key={co.id}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => pick(co.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-bg/60",
                  isActive ? "font-semibold text-primary" : "text-ink-secondary",
                )}
              >
                <Check
                  size={13}
                  strokeWidth={2.5}
                  className={cn("shrink-0", isActive ? "text-primary" : "text-transparent")}
                />
                <span className="min-w-0 flex-1 truncate">{co.name}</span>
                <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-ink-muted">
                  {co.code}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Route → label fallback ─────────────────────────────────
// Quick mapping for pages that don't push breadcrumbs themselves.
// Keeps the navbar from rendering as an empty strip.
const ROUTE_LABELS: Array<[RegExp, string]> = [
  [/^\/$/, "Overview"],
  [/^\/orders\/.+$/, "Sales Order"],
  [/^\/orders$/, "Sales Orders"],
  [/^\/delivery-orders$/, "Delivery Orders"],
  [/^\/delivery\/.+$/, "Delivery"],
  [/^\/logistics$/, "Logistics"],
  [/^\/trips\/.+$/, "Trip"],
  [/^\/lorries\/.+$/, "Lorry"],
  [/^\/staff\/.+$/, "Staff"],
  [/^\/po\/.+$/, "Purchase Order"],
  [/^\/po$/, "Purchase Orders"],
  [/^\/creditors\/.+$/, "Creditor"],
  [/^\/assr\/.+$/, "Service Case"],
  [/^\/assr$/, "Service Cases"],
  [/^\/my-cases\/.+$/, "My Case"],
  [/^\/my-cases$/, "My Cases"],
  [/^\/projects\/.+$/, "Project"],
  [/^\/projects$/, "Projects"],
  [/^\/sales$/, "Sales"],
  [/^\/team$/, "Team"],
  [/^\/gamification$/, "Engagement"],
  [/^\/settings$/, "Settings"],
  [/^\/profile$/, "Profile"],
  [/^\/mail-center\/.+$/, "Mail Center"],
  [/^\/mail-center$/, "Mail Center"],
  [/^\/agents$/, "Agent Console"],
  [/^\/system-health$/, "System Health"],
  [/^\/reports\/fair-report$/, "Sales Report"],
  // The Supply Chain hub is a single-segment route, so it never reaches the
  // /scm/* segment table below (which needs a 2nd segment). Curate it here —
  // without this entry labelForPath title-cased the slug to a bare "Scm".
  [/^\/scm$/, "Supply Chain"],
];

// SCM V2 routes ship dozens of /scm/* pages — hand-rolling a regex per page
// bloats the list. Instead the second URL segment picks the label from this
// table: [plural, singular] where plural covers the listing (and its
// action children like /new or /from-*) and singular covers the detail
// page (a trailing entity id). Kept as one central table so adding a new
// SCM route only means one map entry, not two regex lines.
const SCM_SEGMENT_LABELS: Record<string, [string, string]> = {
  // Sales chain
  "sales-orders": ["Sales Orders", "Sales Order"],
  "delivery-orders": ["Delivery Orders", "Delivery Order"],
  "sales-invoices": ["Sales Invoices", "Sales Invoice"],
  "delivery-returns": ["Delivery Returns", "Delivery Return"],
  "amendments": ["Amendments", "Amendment"],
  // Procurement chain
  "purchase-orders": ["Purchase Orders", "Purchase Order"],
  "purchase-invoices": ["Purchase Invoices", "Purchase Invoice"],
  "purchase-returns": ["Purchase Returns", "Purchase Return"],
  "grns": ["Goods Received Notes", "Goods Received Note"],
  "mrp": ["MRP", "MRP"],
  "suppliers": ["Suppliers", "Supplier"],
  // Warehouse / stock
  "warehouses": ["Warehouses", "Warehouse"],
  "inventory": ["Inventory", "Inventory"],
  "stock-adjustments": ["Stock Adjustments", "Stock Adjustment"],
  "stock-transfers": ["Stock Transfers", "Stock Transfer"],
  "stock-takes": ["Stock Takes", "Stock Take"],
  // Products
  "products": ["Products", "Product"],
  "categories": ["Categories", "Category"],
  "product-models": ["Product Models", "Product Model"],
  "fabric-tracking": ["Fabric Tracking", "Fabric Tracking"],
  // Finance
  "accounting": ["Accounting", "Accounting"],
  "outstanding": ["Outstanding", "Outstanding"],
  "unbilled-deliveries": ["Not Billed", "Delivered, Not Yet Billed"],
  "payment-vouchers": ["Payment Vouchers", "Payment Voucher"],
  "currencies": ["Currencies", "Currency"],
  // Transportation
  "drivers": ["Drivers", "Driver"],
  "delivery-planning": ["Delivery Planning", "Delivery Planning"],
  "delivery-planning-regions": ["Delivery Planning Regions", "Delivery Planning Regions"],
  "fleet": ["Fleet", "Fleet"],
  "lorry-capacity": ["Lorry Capacity", "Lorry Capacity"],
  // Consignment (sale side)
  "consignment-orders": ["Consignment Orders", "Consignment Order"],
  "consignment-notes": ["Consignment Notes", "Consignment Note"],
  "consignment-returns": ["Consignment Returns", "Consignment Return"],
  // Consignment (purchase side)
  "purchase-consignment-orders": ["Purchase Consignment Orders", "Purchase Consignment Order"],
  "purchase-consignment-receives": ["Purchase Consignment Receives", "Purchase Consignment Receive"],
  "purchase-consignment-returns": ["Purchase Consignment Returns", "Purchase Consignment Return"],
  // Section hubs — the Level-2 sub-group landing pages (ScmSubgroupHub). Their
  // slug is the singular group id and the label mirrors the NAV_TABS group
  // header the hub itself renders as its title (no detail child → singular ==
  // plural). Without these, /scm/<group> title-cased the slug to "Scm".
  "sales-order": ["Sales Order", "Sales Order"],
  "consignment": ["Consignment", "Consignment"],
  "procurement": ["Procurement", "Procurement"],
  "transportation": ["Transportation", "Transportation"],
  "warehouse": ["Warehouse", "Warehouse"],
  "finance": ["Finance", "Finance"],
  // Misc
  "maintenance": ["Maintenance", "Maintenance"],
};

// /scm/reports/<report-slug> — its own table since these live one level
// deeper (segs[2] is the report slug).
const SCM_REPORT_LABELS: Record<string, string> = {
  "sales-order-detail-listing": "SO Detail Listing",
  "delivery-order-detail-listing": "DO Detail Listing",
  "sales-invoice-detail-listing": "SI Detail Listing",
  "delivery-return-detail-listing": "DR Detail Listing",
};

// /scm/hr/<leaf-slug> — HR sits one level deeper too (segs[2] is the leaf) and
// has no /scm/hr hub page, so like reports it gets its own table. Labels mirror
// the NAV_TABS HR leaves. Without this, /scm/hr/* title-cased "scm" to "Scm".
const SCM_HR_LABELS: Record<string, string> = {
  "commission": "Commission",
  "settings": "HR Settings",
};

// Path segments that are actions/children rather than entity IDs — used to
// keep the plural label on /scm/<x>/new, /scm/<x>/from-so, etc. Anything
// not in this set (and not obviously an action prefix) is treated as an
// entity id → singular label.
const SCM_ACTION_SEGMENTS = new Set([
  "new",
  "guided",
  "maintenance",
  "generate",
  "stock-card",
]);

function isScmActionSegment(seg: string): boolean {
  if (SCM_ACTION_SEGMENTS.has(seg)) return true;
  if (seg.startsWith("from-")) return true;
  return false;
}

function labelForPath(pathname: string): string {
  for (const [re, label] of ROUTE_LABELS) {
    if (re.test(pathname)) return label;
  }
  const segs = pathname.split("/").filter(Boolean);
  // /scm/* — resolve via the segment tables above.
  if (segs[0] === "scm" && segs.length >= 2) {
    if (segs[1] === "reports" && segs[2]) {
      return SCM_REPORT_LABELS[segs[2]] ?? "Report";
    }
    if (segs[1] === "hr" && segs[2]) {
      return SCM_HR_LABELS[segs[2]] ?? "HR";
    }
    const entry = SCM_SEGMENT_LABELS[segs[1]];
    if (entry) {
      const [plural, singular] = entry;
      const isDetail = !!segs[2] && !isScmActionSegment(segs[2]);
      return isDetail ? singular : plural;
    }
    // Unknown /scm/* — fall through to the generic first-segment
    // uppercase so at least it reads something, not blank.
  }
  const seg = segs[0] || "";
  return seg ? seg[0].toUpperCase() + seg.slice(1) : "";
}
