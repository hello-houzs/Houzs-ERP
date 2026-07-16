import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { isDirectorUser } from "../auth/salesAccess";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { makeNavVisible } from "../components/navFilter";
import { NotifyProvider, useNotify } from "../vendor/scm/components/NotifyDialog";
import { ConfirmProvider, useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { PromptProvider } from "../vendor/scm/components/PromptDialog";
import { ChoiceProvider } from "../vendor/scm/components/ChoiceDialog";
import { registerDialogService } from "../vendor/scm/lib/dialog-service";
import { invalidateSoShared } from "./sharedInvalidate";
import { IosInstallGuide } from "../components/IosInstallGuide";
import { AndroidInstallGuide } from "../components/AndroidInstallGuide";
// Heavy mobile screens are lazy-loaded so the initial mobile chunk stays small
// (desktop routes were already lazy — this closes the mobile gap that made the
// first mobile paint download/parse a ~10k-line monolith). Rendered under the
// <Suspense> boundaries in MobileAppInner. Types import separately so they don't
// pull a module into the eager bundle. MobileModuleList stays EAGER: its
// MODULE_CONFIGS / FORM_MEMBERS_EDIT are read synchronously by the routing +
// form logic below, so it can't be deferred without splitting those out first.
import { MobileModuleList, MODULE_CONFIGS, FORM_MEMBERS_EDIT } from "./MobileModuleList";
import type { SearchNav } from "./MobileSearch";
import type { MobileScanPrefill } from "./MobileScan";
import type { ConvertTarget } from "./MobileConvertWizard";
const MobileSalesOrders = lazy(() => import("./MobileSalesOrders").then((m) => ({ default: m.MobileSalesOrders })));
const MobileAmendments = lazy(() => import("./MobileAmendments").then((m) => ({ default: m.MobileAmendments })));
const MobileSODetail = lazy(() => import("./MobileSODetail").then((m) => ({ default: m.MobileSODetail })));
const MobileNewSO = lazy(() => import("./MobileNewSO").then((m) => ({ default: m.MobileNewSO })));
const MobileCalendar = lazy(() => import("./MobileCalendar").then((m) => ({ default: m.MobileCalendar })));
const MobileSearch = lazy(() => import("./MobileSearch").then((m) => ({ default: m.MobileSearch })));
const MobileInbox = lazy(() => import("./MobileInbox").then((m) => ({ default: m.MobileInbox })));
const MobileServiceCase = lazy(() => import("./MobileServiceCase").then((m) => ({ default: m.MobileServiceCase })));
const MobilePMS = lazy(() => import("./MobilePMS").then((m) => ({ default: m.MobilePMS })));
const MobileMailCenter = lazy(() => import("./MobileMailCenter").then((m) => ({ default: m.MobileMailCenter })));
const MobileAnnouncements = lazy(() => import("./MobileAnnouncements").then((m) => ({ default: m.MobileAnnouncements })));
const MobileModuleDetail = lazy(() => import("./MobileModuleDetail").then((m) => ({ default: m.MobileModuleDetail })));
const MobileModuleForm = lazy(() => import("./MobileModuleForm").then((m) => ({ default: m.MobileModuleForm })));
const MobileDeliveryPlanning = lazy(() => import("./MobileDeliveryPlanning").then((m) => ({ default: m.MobileDeliveryPlanning })));
const MobileScan = lazy(() => import("./MobileScan").then((m) => ({ default: m.MobileScan })));
const MobileConvertWizard = lazy(() => import("./MobileConvertWizard").then((m) => ({ default: m.MobileConvertWizard })));
const MobilePOD = lazy(() => import("./MobilePOD").then((m) => ({ default: m.MobilePOD })));
const MobileProfile = lazy(() => import("./MobileProfile").then((m) => ({ default: m.MobileProfile })));
const MobileStockCard = lazy(() => import("./MobileStockCard").then((m) => ({ default: m.MobileStockCard })));
const MobileStockTransferNew = lazy(() => import("./MobileStockTransferNew").then((m) => ({ default: m.MobileStockTransferNew })));
// SO Maintenance is the SAME desktop page (/scm/sales-orders/maintenance) — the
// director-only State→Warehouse / Localities / SO-dropdown CRUD surface. Mobile
// has no route table, so the vendored desktop page is mounted directly inside
// its provider shell (Scm2990Shell) as a full-screen overlay. It's a desktop-
// oriented layout (owner accepted this — the ask was to give directors the
// entry on their phone, matching desktop; see BUG-HISTORY 2026-07-15).
const ScmSalesOrderMaintenance = lazy(() => import("../pages/scm-v2/SalesOrderMaintenance").then((m) => ({ default: m.SalesOrderMaintenance })));
const Scm2990Shell = lazy(() => import("../pages/scm-v2/Scm2990Shell"));
import "./mobile.css";

type Tab = "orders" | "service" | "calendar" | "profile";
type Screen =
  | { t: "tab" }
  | { t: "search" }
  | { t: "so-detail"; docNo: string }
  | { t: "amendments" }
  | { t: "so-maintenance" }
  | { t: "new-so"; mode: "new" | "edit" | "edit-draft"; docNo?: string; scanPrefill?: MobileScanPrefill }
  | { t: "scan" }
  | { t: "module"; key: string; title: string }
  | { t: "module-detail"; key: string; row: any; title: string }
  | { t: "stock-transfer-new"; key: string; row: any; title: string }
  | { t: "module-form"; key: string; mode: "new" | "edit"; row?: any }
  | { t: "convert"; key: string; title: string; target: ConvertTarget; initialSourceId?: string }
  | { t: "pod"; docNo: string }
  | { t: "service"; startNew?: boolean }
  | { t: "delivery-planning" }
  | { t: "pms"; projectId?: number }
  | { t: "mail" }
  | { t: "announcements" }
  | { t: "inbox" }
  | { t: "stub"; title: string };

// Doc modules whose "+ New" opens a convert wizard (create by converting a
// source doc), matching desktop. Others with a `form` open MobileModuleForm.
const MODULE_TO_CONVERT: Record<string, ConvertTarget> = {
  "delivery-orders-mfg": "do",
  "sales-invoices": "si",
  "grns": "grn",
  "mfg-purchase-orders": "po",
};

const ROUTE_TO_CONFIG: Record<string, string> = {
  "/scm/sales-invoices": "sales-invoices",
  "/scm/delivery-orders": "delivery-orders-mfg",
  "/scm/delivery-returns": "delivery-returns",
  "/scm/mrp": "mrp",
  "/scm/purchase-orders": "mfg-purchase-orders",
  "/scm/grns": "grns",
  "/scm/purchase-invoices": "purchase-invoices",
  "/scm/purchase-returns": "purchase-returns",
  "/scm/products": "products",
  "/scm/suppliers": "suppliers",
  "/scm/fleet": "fleet",
  "/scm/drivers": "drivers",
  "/scm/warehouses": "warehouse",
  "/scm/inventory": "inventory",
};

/** The mobile Menu mirrors the owner's design prototype `var MENU`
 *  (Houzs Mobile.html) — same groups, order, and labels, EXCEPT the
 *  Organisation group, which the owner moved into the Profile screen
 *  (2026-07 "这全部在 profile 里面" — see PROFILE_ORG_ITEMS below). Each item
 *  opens a real mobile screen and is still permission-gated by the matching
 *  desktop nav entry (an item whose nav tab isn't visible for the user's
 *  position is hidden). The bottom tabs cover Sales Orders / Calendar /
 *  Inbox / Profile. */
const MOBILE_MENU_GROUPS: { group: string; items: { to: string; label: string; alwaysShow?: boolean; directorOnly?: boolean }[] }[] = [
  { group: "Sales & Finance", items: [
    { to: "/scm/sales-orders", label: "Sales Orders" },
    { to: "/scm/amendments", label: "Amendments" },
    /* SO Maintenance — DIRECTOR-only (Super Admin / Sales Director / Finance
       Manager / Owner-IT `*`, via auth/salesAccess.isDirectorUser), the same
       gate the desktop SO-list button + route use (MfgSalesOrdersListV2
       `canMaintain`, App.tsx SoMaintenanceGuard). `directorOnly` bypasses the
       nav-tab `allowed()` check because this destination isn't a NAV_TABS entry
       (it's a toolbar button on desktop). OFF, not hide: a non-director never
       gets this row rendered and never reaches the screen. */
    { to: "/scm/sales-orders/maintenance", label: "SO Maintenance", directorOnly: true },
    { to: "/scm/delivery-orders", label: "Delivery Orders" },
    { to: "/scm/sales-invoices", label: "Sales Invoices" },
    { to: "/scm/delivery-returns", label: "Delivery Returns" },
  ]},
  { group: "Projects · PMS", items: [
    { to: "/projects", label: "Projects" },
  ]},
  { group: "After-sales", items: [
    { to: "/assr", label: "Service Case" },
  ]},
  { group: "Procurement & MRP", items: [
    { to: "/scm/mrp", label: "MRP · Stock Status" },
    { to: "/scm/purchase-orders", label: "Purchase Orders" },
    { to: "/scm/grns", label: "Goods Receipt" },
    { to: "/scm/purchase-invoices", label: "Purchase Invoices" },
    { to: "/scm/purchase-returns", label: "Purchase Returns" },
    { to: "/scm/products", label: "Products & Maintenance" },
    { to: "/scm/suppliers", label: "Suppliers" },
  ]},
  { group: "Logistics", items: [
    { to: "/scm/delivery-planning", label: "Delivery Planning" },
    { to: "/scm/fleet", label: "Fleet" },
    { to: "/scm/drivers", label: "Drivers" },
  ]},
  { group: "Warehouse", items: [
    { to: "/scm/warehouses", label: "Warehouse" },
    { to: "/scm/inventory", label: "Inventory" },
  ]},
];

/** Organisation destinations — owner 2026-07: these do NOT live in the module
 *  menu ("这全部在 profile 里面") — they are rows inside the Profile screen.
 *  Same routes and the SAME per-item permission gate (`allowed`) the menu
 *  applied when they lived there; an item hidden from the old menu stays
 *  hidden in Profile. */
const PROFILE_ORG_ITEMS: { to: string; label: string; alwaysShow?: boolean }[] = [
  { to: "/activity-inbox", label: "Inbox" },
  { to: "/mail-center", label: "Mail Center" },
  /* Owner rule 2026-07: Announcements is readable by EVERY active user —
     the mobile screen reads /api/announcements/banner, which needs no
     permission and is audience-filtered server-side (only notices addressed
     to this user). So this row bypasses the desktop nav gate
     (announcements.read = the desktop ADMIN list/composer permission). */
  { to: "/announcements", label: "Announcements", alwaysShow: true },
  { to: "/team?tab=members", label: "Members" },
  { to: "/team?tab=positions", label: "Positions" },
  { to: "/team?tab=departments", label: "Departments" },
];

/** Mobile app shell — bottom tab bar + slide-up module menu, permission-gated
 *  (same page_access the desktop uses). Every menu route maps to a real mobile
 *  screen; the menu is limited to MOBILE_MENU (the design's module set). */
/** Registers the live confirm + notify fns with the module-level dialog-service
 *  bridge so non-React callers (authedFetch's short-stock gate, query onError)
 *  raise the in-app dialogs on mobile too. Renders inside both providers. */
function MobileDialogBridge() {
  const notify = useNotify();
  const confirm = useConfirm();
  useEffect(() => {
    registerDialogService({ confirm, notify });
  }, [confirm, notify]);
  return null;
}

// Shown while a lazy screen's chunk is in flight. Absolutely positioned so it
// fills its Suspense container (the overlay slot or the tab-content slot) without
// disturbing the persistent tab bar, which lives outside the boundary.
function MobileScreenFallback() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--app-bg)",
      }}
    >
      <div
        className="animate-pulse"
        style={{ width: 120, height: 12, borderRadius: 6, background: "var(--border, #d8d5c8)" }}
      />
    </div>
  );
}

export function MobileApp() {
  return (
    <NotifyProvider>
      <ConfirmProvider>
        <PromptProvider>
          <ChoiceProvider>
            <MobileDialogBridge />
            {/* Manual install coaches. Previously mounted only in the desktop
                App shell, so phone users whose browser never fires
                beforeinstallprompt (iOS Safari, Samsung Internet, in-app
                webviews, Chrome post-decline) got NO install path at all —
                the guides self-guard on platform/standalone/cool-off, and
                the Android one defers to PwaBanners' one-tap Install. */}
            <IosInstallGuide />
            <AndroidInstallGuide />
            <MobileAppInner />
          </ChoiceProvider>
        </PromptProvider>
      </ConfirmProvider>
    </NotifyProvider>
  );
}

function MobileAppInner() {
  const { user, can, pageAccess, logout } = useAuth();
  const notify = useNotify();
  const qc = useQueryClient();

  // Single-source the mobile gating on the SHARED per-node predicate the desktop
  // Sidebar + MobileTabBar filter with (components/navFilter.makeNavVisible), so
  // the mobile shell can never drift back into a hand-copied subset that omitted
  // pageAccessFull / hidePerm / requireFinanceViewer. `allowed(to)` answers "is
  // the nav destination at this path visible for the user"; a route that isn't in
  // NAV_TABS at all still shows (backend-gated, e.g. /activity-inbox).
  const navVisible = makeNavVisible({ user, can, pageAccess });
  const flatNav: NavTab[] = [];
  const walkNav = (t: NavTab) => { flatNav.push(t); (t.children ?? []).forEach(walkNav); };
  NAV_TABS.forEach(walkNav);
  const allowed = (to: string): boolean => {
    const path = to.split("?")[0];
    const matches = flatNav.filter((t) => t.to != null && t.to.split("?")[0] === path);
    return matches.length === 0 ? true : matches.some(navVisible);
  };

  // Bottom-tab access — a tab whose destination the user can't reach must NOT
  // mount its screen (its screen fires ungated queries → 403). Mirror the exact
  // capability the desktop nav uses: Orders = the /scm/sales-orders shortcut,
  // Service = the /assr Service-Cases group (service_cases.read OR Sales staff
  // via showForSales), Calendar = projects.calendar page access. Profile always.
  const canOrders = allowed("/scm/sales-orders");
  const canService = allowed("/assr");
  const canCalendar = pageAccess("projects.calendar") !== "none";
  // Land on the first tab the user can actually open (falls back to Profile) so
  // no one starts on a locked screen.
  const firstTab: Tab = canOrders ? "orders" : canService ? "service" : canCalendar ? "calendar" : "profile";

  const [tab, setTab] = useState<Tab>(firstTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>({ t: "tab" });
  const back = () => setScreen({ t: "tab" });

  // Search → calendar jump target. When a project search hit is tapped we route
  // to the Calendar tab and snap it to the project's start-date month, with the
  // project's bar highlighted (see MobileCalendar focusProjectId). A monotonic
  // nonce lets a repeat jump to the SAME month re-fire the calendar's effects.
  const [calJump, setCalJump] = useState<{ year: number; month: number; projectId: number; nonce: number } | null>(null);

  // Route a typed search hit onto the right mobile screen.
  const onSearchNavigate = (nav: SearchNav) => {
    switch (nav.kind) {
      case "sales_order":
        return setScreen({ t: "so-detail", docNo: nav.docNo });
      case "project": {
        // A dated project jumps the calendar to its month + highlights it; an
        // undated one falls back to opening the project in PMS.
        const iso = (nav.date ?? "").slice(0, 10);
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
        if (m) {
          setCalJump({ year: Number(m[1]), month: Number(m[2]) - 1, projectId: nav.projectId, nonce: Date.now() });
          setTab("calendar");
          return setScreen({ t: "tab" });
        }
        return setScreen({ t: "pms", projectId: nav.projectId });
      }
      case "assr_case":
        return setScreen({ t: "service" });
      case "product":
        return MODULE_CONFIGS["products"]
          ? setScreen({ t: "module", key: "products", title: "Products & Maintenance" })
          : setScreen({ t: "tab" });
      case "user":
        return MODULE_CONFIGS["members"]
          ? setScreen({ t: "module", key: "members", title: "Members" })
          : setScreen({ t: "tab" });
    }
  };

  /* Scan → background DRAFT: MobileScan has FIRED the enqueue(s)/create(s).
     The operator now STAYS on the Scan screen (owner 2026-07-04) watching the
     Recent-scans pills progress — navigation was split OUT of this handler; he
     leaves via Cancel/back whenever. This handler only nudges the Orders-list
     query (so the drafts surface when he does go back) and toasts. */
  const onScanDrafted = (count: number) => {
    /* The minted draft is an ordinary SO, so the desktop SO lists must refetch
       alongside the phone's own list — the job creates it server-side, where no
       mutation hook runs to invalidate anything. */
    const bumpSoLists = () => {
      void qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] });
      invalidateSoShared(qc);
    };
    bumpSoLists();
    // The scan runs as a BACKGROUND job now (upload returns before the OCR),
    // so refetch again on the OCR's typical timescale — a slow job still
    // surfaces its draft without the operator reloading.
    window.setTimeout(bumpSoLists, 2500);
    window.setTimeout(bumpSoLists, 45_000);
    window.setTimeout(bumpSoLists, 120_000);
    void notify({
      title: count > 1 ? `${count} orders uploaded` : "Order uploaded",
      body: count > 1
        ? "They're being read in the background — watch their progress under Recent scans, or close the app. Each one appears in Orders as a draft when it finishes."
        : "It's being read in the background — watch its progress under Recent scans, or close the app. It appears in Orders as a draft when it finishes.",
    });
  };

  // Build the grouped mobile Menu from MOBILE_MENU_GROUPS (design mirror), keeping
  // only items whose matching desktop nav tab is visible for this user's position
  // (via the shared `allowed` above). Items with no nav match still show (backend
  // gates).
  const menuGroups = MOBILE_MENU_GROUPS
    .map((g) => ({ group: g.group, items: g.items.filter((it) => (it.directorOnly ? isDirectorUser(user) : (it.alwaysShow || allowed(it.to)))) }))
    .filter((g) => g.items.length > 0);

  // Organisation rows shown inside the Profile screen — gated by the SAME
  // `allowed` check (+ Announcements' alwaysShow bypass) the menu used when
  // these items lived in its Organisation group.
  const profileOrgItems = PROFILE_ORG_ITEMS.filter((it) => it.alwaysShow || allowed(it.to));

  const openRoute = (to: string, label: string) => {
    setMenuOpen(false);
    const path = (to || "").split("?")[0];
    if (path === "/scm/sales-orders") { setTab("orders"); setScreen({ t: "tab" }); return; }
    if (path === "/scm/sales-orders/maintenance") return setScreen({ t: "so-maintenance" });
    if (path === "/scm/amendments") return setScreen({ t: "amendments" });
    if (path === "/assr") return setScreen({ t: "service" });
    if (path === "/projects") return setScreen({ t: "pms" });
    if (path === "/mail-center") return setScreen({ t: "mail" });
    if (path === "/announcements") return setScreen({ t: "announcements" });
    if (path === "/activity-inbox") return setScreen({ t: "inbox" });
    if (path === "/scm/delivery-planning") return setScreen({ t: "delivery-planning" });
    if (path === "/team") {
      const tab = new URLSearchParams((to.split("?")[1] || "")).get("tab");
      const teamKey = tab === "members" ? "members" : tab === "positions" ? "positions" : tab === "departments" ? "departments" : null;
      if (teamKey && MODULE_CONFIGS[teamKey]) return setScreen({ t: "module", key: teamKey, title: label });
      return setScreen({ t: "stub", title: label });
    }
    const key = ROUTE_TO_CONFIG[path];
    if (key && MODULE_CONFIGS[key]) return setScreen({ t: "module", key, title: label });
    setScreen({ t: "stub", title: label });
  };

  // Overlay screens (pushed above the tab bar). These resolve to lazy-loaded
  // components, so the chosen element is returned under a single <Suspense>
  // boundary (full-screen fallback — an overlay owns the whole viewport anyway).
  let overlay: ReactNode = null;
  if (screen.t === "search") overlay = <MobileSearch onBack={back} onNavigate={onSearchNavigate} />;
  else if (screen.t === "so-detail") overlay = <MobileSODetail docNo={screen.docNo} onBack={back} onEdit={(d) => setScreen({ t: "new-so", mode: "edit", docNo: d })} />;
  else if (screen.t === "amendments") overlay = <MobileAmendments onBack={back} onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })} />;
  else if (screen.t === "so-maintenance") {
    // Director-only, defence-in-depth: even though the menu row is director-gated,
    // don't mount the maintenance page (or its data hooks) for a non-director —
    // mirrors App.tsx SoMaintenanceGuard. OFF, not hide.
    overlay = !isDirectorUser(user) ? (
      <TabLocked title="SO Maintenance" />
    ) : (
      <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
        <header style={{ background: "#fff", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
          <button onClick={back} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--teal)", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>‹ Back</button>
          <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>SO Maintenance</div>
        </header>
        {/* The vendored desktop maintenance page mounted inside its provider shell.
            Desktop-oriented layout — scrolls within this container on a phone. */}
        <div style={{ flex: 1, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
          <Scm2990Shell><ScmSalesOrderMaintenance /></Scm2990Shell>
        </div>
      </div>
    );
  }
  else if (screen.t === "new-so") overlay = <MobileNewSO mode={screen.mode} docNo={screen.docNo} scanPrefill={screen.scanPrefill} onBack={back} onSaved={(d) => setScreen({ t: "so-detail", docNo: d })} />;
  else if (screen.t === "scan") overlay = <MobileScan onBack={back} onDrafted={onScanDrafted} onOpenSo={(docNo) => setScreen({ t: "so-detail", docNo })} />;
  else if (screen.t === "module") {
    const k = screen.key;
    const convertTarget = MODULE_TO_CONVERT[k];
    const onNew = convertTarget
      ? () => setScreen({ t: "convert", key: k, title: screen.title, target: convertTarget })
      : MODULE_CONFIGS[k]?.form
        ? () => setScreen({ t: "module-form", key: k, mode: "new" })
        : undefined;
    overlay = <MobileModuleList config={MODULE_CONFIGS[k]} onBack={back}
      onOpen={(row) => setScreen({ t: "module-detail", key: k, row, title: screen.title })}
      onNew={onNew} />;
  }
  else if (screen.t === "convert") {
    // Convert is entered from a module list ("+ New") → return to that list
    // afterwards. If ever re-seeded with an initialSourceId (source doc), return
    // to that SO detail instead so the operator sees the updated state.
    const fromSo = screen.target === "do" && !!screen.initialSourceId;
    const backToConvertHome = fromSo
      ? () => setScreen({ t: "so-detail", docNo: screen.initialSourceId! })
      : () => setScreen({ t: "module", key: screen.key, title: screen.title });
    overlay = <MobileConvertWizard target={screen.target} initialSourceId={screen.initialSourceId} onBack={backToConvertHome} onCreated={backToConvertHome} />;
  }
  else if (screen.t === "module-detail" && screen.key === "inventory") {
    // Inventory row → the richer per-SKU stock card (replaces the generic detail).
    overlay = <MobileStockCard
      productCode={screen.row?.product_code ?? ""}
      productName={screen.row?.product_name ?? null}
      canTransfer={allowed("/scm/stock-transfers")}
      onBack={() => setScreen({ t: "module", key: screen.key, title: screen.title })}
      onNewTransfer={() => setScreen({ t: "stock-transfer-new", key: screen.key, row: screen.row, title: screen.title })} />;
  }
  else if (screen.t === "stock-transfer-new") {
    const backToCard = () => setScreen({ t: "module-detail", key: screen.key, row: screen.row, title: screen.title });
    overlay = <MobileStockTransferNew onBack={backToCard} onCreated={backToCard} />;
  }
  else if (screen.t === "module-detail") {
    const doNo = screen.key === "delivery-orders-mfg" ? (screen.row?.do_number ?? screen.row?.doNumber) : null;
    overlay = <MobileModuleDetail moduleKey={screen.key} row={screen.row} title={screen.title}
      onBack={() => setScreen({ t: "module", key: screen.key, title: screen.title })}
      onEdit={() => setScreen({ t: "module-form", key: screen.key, mode: "edit", row: screen.row })}
      onPOD={doNo ? () => setScreen({ t: "pod", docNo: String(doNo) }) : undefined} />;
  }
  else if (screen.t === "module-form") {
    const cfg = MODULE_CONFIGS[screen.key];
    const schema = screen.mode === "edit" && screen.key === "members" ? FORM_MEMBERS_EDIT : cfg?.form;
    const title = cfg?.title ?? screen.key;
    overlay = !schema ? <Stub title={title} onBack={back} /> : (
      <MobileModuleForm schema={schema} mode={screen.mode} initial={screen.mode === "edit" ? screen.row : undefined}
        onBack={() => setScreen(screen.mode === "edit" && screen.row ? { t: "module-detail", key: screen.key, row: screen.row, title } : { t: "module", key: screen.key, title })}
        onSaved={() => setScreen({ t: "module", key: screen.key, title })} />
    );
  }
  else if (screen.t === "pod") overlay = <MobilePOD docNo={screen.docNo} onBack={back} onDone={back} />;
  else if (screen.t === "service") overlay = <MobileServiceCase onBack={back} startNew={screen.startNew} />;
  else if (screen.t === "delivery-planning") overlay = <MobileDeliveryPlanning onBack={back} onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })} />;
  else if (screen.t === "pms") overlay = <MobilePMS onBack={back} initialProjectId={screen.projectId} />;
  else if (screen.t === "mail") overlay = <MobileMailCenter onBack={back} />;
  else if (screen.t === "announcements") overlay = <MobileAnnouncements onBack={back} />;
  else if (screen.t === "inbox") overlay = <MobileInbox onBack={back} onOpen={(n) => { const doc = (n as { doc_no?: string }).doc_no; if (doc) setScreen({ t: "so-detail", docNo: doc }); }} />;
  else if (screen.t === "stub") overlay = <Stub title={screen.title} onBack={back} />;
  if (overlay !== null) return <Suspense fallback={<MobileScreenFallback />}>{overlay}</Suspense>;

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Suspense wraps only the tab CONTENT — the tab bar below stays mounted,
            so switching to a not-yet-loaded tab shows a content skeleton without
            the nav flashing. */}
        <Suspense fallback={<MobileScreenFallback />}>
          {/* Each content tab mounts its screen ONLY when the user can reach the
              destination (same makeNavVisible gate as the nav). A tab the user
              can't access renders a locked placeholder instead of the real screen
              — so its ungated queries (/api/scm/mfg-sales-orders, /api/assr,
              /api/projects/calendar…) never fire a 403 (OFF, not hide). */}
          {tab === "orders" && (canOrders ? (
            <MobileSalesOrders
              onScan={() => setScreen({ t: "scan" })}
              onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })}
              onNew={() => setScreen({ t: "new-so", mode: "new" })}
              // FAB "+" second action — open the service-case create sheet on the
              // Service screen (parity with the desktop QuickActionsFAB two-choice).
              onNewCase={() => setScreen({ t: "service", startNew: true })}
            />
          ) : <TabLocked title="Sales Orders" />)}
          {tab === "service" && (canService
            ? <MobileServiceCase onBack={() => setTab(firstTab)} />
            : <TabLocked title="Service Cases" />)}
          {tab === "calendar" && (canCalendar ? (
            <MobileCalendar
              onOpenProject={(id) => setScreen({ t: "pms", projectId: id })}
              onOpenSearch={() => setScreen({ t: "search" })}
              // Search → calendar jump: keyed by the jump nonce so re-jumping to the
              // same month re-triggers the snap + highlight.
              key={calJump ? `caljump-${calJump.nonce}` : "cal"}
              initialYear={calJump?.year}
              initialMonth={calJump?.month}
              focusProjectId={calJump?.projectId}
            />
          ) : <TabLocked title="Calendar" />)}
          {tab === "profile" && <MobileProfile onLogout={logout} orgItems={profileOrgItems} onOpenOrg={openRoute} />}
        </Suspense>
      </div>

      <div className="navwrap">
        <nav className="tabbar">
          <button className={`tab${tab === "orders" ? " on" : ""}`} onClick={() => setTab("orders")}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l4 4v14H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v4h4" /><path d="M9.5 12.5h5M9.5 16h3" /></svg>
            <span className="tl">Orders</span>
          </button>
          <button className={`tab${tab === "service" ? " on" : ""}`} onClick={() => setTab("service")}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M15.3 7.3a3.8 3.8 0 0 1-4.9 4.9l-5.1 5.1a1.8 1.8 0 0 1-2.6-2.6l5.1-5.1a3.8 3.8 0 0 1 4.9-4.9l-2.3 2.3a1 1 0 0 0 0 1.4l1.2 1.2a1 1 0 0 0 1.4 0Z" /></svg>
            <span className="tl">Service</span>
          </button>
          <div className="tab-center">
            {/* center Menu disc — icon ported VERBATIM from the owner's design
                prototype (houzs-mobile.html `var DISC`): a 4-square grid / apps
                icon (four rounded rects), NOT the hamburger. Toggles the
                permission-gated module sheet, matching the design's toggle. */}
            <button className="disc" onClick={() => setMenuOpen((s) => !s)} aria-label="Menu">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" /></svg>
            </button>
          </div>
          <button className={`tab${tab === "calendar" ? " on" : ""}`} onClick={() => setTab("calendar")}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>
            <span className="tl">Calendar</span>
          </button>
          <button className={`tab${tab === "profile" ? " on" : ""}`} onClick={() => setTab("profile")}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.7" /><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" /></svg>
            <span className="tl">Profile</span>
          </button>
        </nav>
      </div>

      {menuOpen && (
        <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) setMenuOpen(false); }}>
          <div className="sheet">
            <div className="grab" />
            <div className="sheet-head">
              <div>
                <div className="ey" style={{ color: "#a16a2e" }}>Menu</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Where to next?</div>
              </div>
              <button className="sheet-x" onClick={() => setMenuOpen(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="sheet-scroll">
              {/* Grouped module menu — mirrors the owner's design MobileShell.tsx
                  sheet: each group is a card with an uppercase group title and a
                  2-column grid of plain label buttons (no per-item / per-group
                  icons, no footer). Routing stays real via openRoute(it.to). */}
              {menuGroups.map(({ group, items }) => (
                <div className="mgroup" key={group}>
                  <div className="mgh"><span className="gl">{group}</span></div>
                  <div className="mgrid">
                    {items.map((it) => (
                      <button className="mcard" key={it.to} onClick={() => openRoute(it.to, it.label)}>
                        <span className="ml">{it.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {menuGroups.length === 0 && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "24px 0" }}>No modules available for your position.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Locked placeholder for a bottom tab the user can't access — the tab button
 *  stays in the fixed bar (design), but its screen (and every query it fires)
 *  never mounts. OFF, not hide: no fetch, no 403. */
function TabLocked({ title }: { title: string }) {
  return (
    <div className="hz-m" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)" }}>{title}</div>
      </header>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9aa093", fontSize: 12.5, padding: 24, textAlign: "center" }}>
        Your position doesn't have access to this section.
      </div>
    </div>
  );
}

function Stub({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
        <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--teal)", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>‹ Back</button>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>{title}</div>
      </header>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9aa093", fontSize: 12.5, padding: 24, textAlign: "center" }}>
        Building this screen next — it will match your design and connect to the live data.
      </div>
    </div>
  );
}

