import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { NotifyProvider, useNotify } from "../vendor/scm/components/NotifyDialog";
import { ConfirmProvider, useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { PromptProvider } from "../vendor/scm/components/PromptDialog";
import { ChoiceProvider } from "../vendor/scm/components/ChoiceDialog";
import { registerDialogService } from "../vendor/scm/lib/dialog-service";
import { MobileSalesOrders } from "./MobileSalesOrders";
import { MobileSODetail } from "./MobileSODetail";
import { MobileNewSO } from "./MobileNewSO";
import { MobileCalendar } from "./MobileCalendar";
import { MobileInbox } from "./MobileInbox";
import { MobileServiceCase } from "./MobileServiceCase";
import { MobilePMS } from "./MobilePMS";
import { MobileMailCenter } from "./MobileMailCenter";
import { MobileAnnouncements } from "./MobileAnnouncements";
import { MobileModuleList, MODULE_CONFIGS, FORM_MEMBERS_EDIT } from "./MobileModuleList";
import { MobileModuleDetail } from "./MobileModuleDetail";
import { MobileModuleForm } from "./MobileModuleForm";
import { MobileDeliveryPlanning } from "./MobileDeliveryPlanning";
import { MobileScan, type MobileScanPrefill } from "./MobileScan";
import { MobileConvertWizard, type ConvertTarget } from "./MobileConvertWizard";
import { MobilePOD } from "./MobilePOD";
import { MobileProfile } from "./MobileProfile";
import "./mobile.css";

type Tab = "orders" | "service" | "calendar" | "profile";
type Screen =
  | { t: "tab" }
  | { t: "so-detail"; docNo: string }
  | { t: "new-so"; mode: "new" | "edit" | "edit-draft"; docNo?: string; scanPrefill?: MobileScanPrefill }
  | { t: "scan" }
  | { t: "module"; key: string; title: string }
  | { t: "module-detail"; key: string; row: any; title: string }
  | { t: "module-form"; key: string; mode: "new" | "edit"; row?: any }
  | { t: "convert"; key: string; title: string; target: ConvertTarget; initialSourceId?: string }
  | { t: "pod"; docNo: string }
  | { t: "service" }
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

/** The mobile Menu is a 1:1 mirror of the owner's design prototype `var MENU`
 *  (Houzs Mobile.html) — SAME groups, order, and labels. Each item opens a real
 *  mobile screen and is still permission-gated by the matching desktop nav entry
 *  (an item whose nav tab isn't visible for the user's position is hidden). The
 *  bottom tabs cover Sales Orders / Calendar / Inbox / Profile. */
const MOBILE_MENU_GROUPS: { group: string; items: { to: string; label: string }[] }[] = [
  { group: "Sales & Finance", items: [
    { to: "/scm/sales-orders", label: "Sales Orders" },
    { to: "/scm/delivery-orders", label: "Delivery Orders" },
    { to: "/scm/sales-invoices", label: "Sales Invoices" },
    { to: "/scm/delivery-returns", label: "Sales Returns" },
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
  { group: "Organisation", items: [
    { to: "/activity-inbox", label: "Inbox" },
    { to: "/team?tab=members", label: "Members" },
    { to: "/team?tab=positions", label: "Positions" },
    { to: "/team?tab=departments", label: "Departments" },
    { to: "/mail-center", label: "Mail Center" },
    { to: "/announcements", label: "Announcements" },
  ]},
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

export function MobileApp() {
  return (
    <NotifyProvider>
      <ConfirmProvider>
        <PromptProvider>
          <ChoiceProvider>
            <MobileDialogBridge />
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
  const [tab, setTab] = useState<Tab>("orders");
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>({ t: "tab" });
  const back = () => setScreen({ t: "tab" });

  /* Scan → background DRAFT: MobileScan has FIRED the enqueue(s)/create(s).
     The operator now STAYS on the Scan screen (owner 2026-07-04) watching the
     Recent-scans pills progress — navigation was split OUT of this handler; he
     leaves via Cancel/back whenever. This handler only nudges the Orders-list
     query (so the drafts surface when he does go back) and toasts. */
  const onScanDrafted = (count: number) => {
    void qc.invalidateQueries({ queryKey: ["mobile-so-list"] });
    // The scan runs as a BACKGROUND job now (upload returns before the OCR),
    // so refetch again on the OCR's typical timescale — a slow job still
    // surfaces its draft without the operator reloading.
    window.setTimeout(() => { void qc.invalidateQueries({ queryKey: ["mobile-so-list"] }); }, 2500);
    window.setTimeout(() => { void qc.invalidateQueries({ queryKey: ["mobile-so-list"] }); }, 45_000);
    window.setTimeout(() => { void qc.invalidateQueries({ queryKey: ["mobile-so-list"] }); }, 120_000);
    void notify({
      title: count > 1 ? `${count} orders uploaded` : "Order uploaded",
      body: count > 1
        ? "They're being read in the background — watch their progress under Recent scans, or close the app. Each one appears in Orders as a draft when it finishes."
        : "It's being read in the background — watch its progress under Recent scans, or close the app. It appears in Orders as a draft when it finishes.",
    });
  };

  const visible = (t: NavTab): boolean => {
    if (t.perm && !can(t.perm)) return false;
    if (t.anyPerm || t.anyAccess) {
      const navPerms = user?.scm_l2_configured && t.anyPerm ? t.anyPerm.filter((p) => p !== "scm.access") : t.anyPerm;
      const permOk = navPerms ? navPerms.some((p) => can(p)) : false;
      const accessOk = t.anyAccess ? t.anyAccess.some((k) => pageAccess(k) !== "none") : false;
      if (!permOk && !accessOk) return false;
    }
    if (t.pageAccess && pageAccess(t.pageAccess) === "none") return false;
    return true;
  };

  // Build the grouped mobile Menu from MOBILE_MENU_GROUPS (design mirror), keeping
  // only items whose matching desktop nav tab is visible for this user's position
  // (permission consistency). Items with no nav match still show (backend gates).
  const flatNav: NavTab[] = [];
  const walkNav = (t: NavTab) => { flatNav.push(t); (t.children ?? []).forEach(walkNav); };
  NAV_TABS.forEach(walkNav);
  const allowed = (to: string): boolean => {
    const path = to.split("?")[0];
    const matches = flatNav.filter((t) => t.to != null && t.to.split("?")[0] === path);
    return matches.length === 0 ? true : matches.some(visible);
  };
  const menuGroups = MOBILE_MENU_GROUPS
    .map((g) => ({ group: g.group, items: g.items.filter((it) => allowed(it.to)) }))
    .filter((g) => g.items.length > 0);

  const openRoute = (to: string, label: string) => {
    setMenuOpen(false);
    const path = (to || "").split("?")[0];
    if (path === "/scm/sales-orders") { setTab("orders"); setScreen({ t: "tab" }); return; }
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

  // Overlay screens (pushed above the tab bar).
  if (screen.t === "so-detail") return <MobileSODetail docNo={screen.docNo} onBack={back} onEdit={(d) => setScreen({ t: "new-so", mode: "edit", docNo: d })} />;
  if (screen.t === "new-so") return <MobileNewSO mode={screen.mode} docNo={screen.docNo} scanPrefill={screen.scanPrefill} onBack={back} onSaved={(d) => setScreen({ t: "so-detail", docNo: d })} />;
  if (screen.t === "scan") return <MobileScan onBack={back} onDrafted={onScanDrafted} onOpenSo={(docNo) => setScreen({ t: "so-detail", docNo })} />;
  if (screen.t === "module") {
    const k = screen.key;
    const convertTarget = MODULE_TO_CONVERT[k];
    const onNew = convertTarget
      ? () => setScreen({ t: "convert", key: k, title: screen.title, target: convertTarget })
      : MODULE_CONFIGS[k]?.form
        ? () => setScreen({ t: "module-form", key: k, mode: "new" })
        : undefined;
    return <MobileModuleList config={MODULE_CONFIGS[k]} onBack={back}
      onOpen={(row) => setScreen({ t: "module-detail", key: k, row, title: screen.title })}
      onNew={onNew} />;
  }
  if (screen.t === "convert") {
    // Convert is entered from a module list ("+ New") → return to that list
    // afterwards. If ever re-seeded with an initialSourceId (source doc), return
    // to that SO detail instead so the operator sees the updated state.
    const fromSo = screen.target === "do" && !!screen.initialSourceId;
    const backToConvertHome = fromSo
      ? () => setScreen({ t: "so-detail", docNo: screen.initialSourceId! })
      : () => setScreen({ t: "module", key: screen.key, title: screen.title });
    return <MobileConvertWizard target={screen.target} initialSourceId={screen.initialSourceId} onBack={backToConvertHome} onCreated={backToConvertHome} />;
  }
  if (screen.t === "module-detail") {
    const doNo = screen.key === "delivery-orders-mfg" ? (screen.row?.do_number ?? screen.row?.doNumber) : null;
    return <MobileModuleDetail moduleKey={screen.key} row={screen.row} title={screen.title}
      onBack={() => setScreen({ t: "module", key: screen.key, title: screen.title })}
      onEdit={() => setScreen({ t: "module-form", key: screen.key, mode: "edit", row: screen.row })}
      onPOD={doNo ? () => setScreen({ t: "pod", docNo: String(doNo) }) : undefined} />;
  }
  if (screen.t === "module-form") {
    const cfg = MODULE_CONFIGS[screen.key];
    const schema = screen.mode === "edit" && screen.key === "members" ? FORM_MEMBERS_EDIT : cfg?.form;
    const title = cfg?.title ?? screen.key;
    if (!schema) return <Stub title={title} onBack={back} />;
    return <MobileModuleForm schema={schema} mode={screen.mode} initial={screen.mode === "edit" ? screen.row : undefined}
      onBack={() => setScreen(screen.mode === "edit" && screen.row ? { t: "module-detail", key: screen.key, row: screen.row, title } : { t: "module", key: screen.key, title })}
      onSaved={() => setScreen({ t: "module", key: screen.key, title })} />;
  }
  if (screen.t === "pod") return <MobilePOD docNo={screen.docNo} onBack={back} onDone={back} />;
  if (screen.t === "service") return <MobileServiceCase onBack={back} />;
  if (screen.t === "delivery-planning") return <MobileDeliveryPlanning onBack={back} onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })} />;
  if (screen.t === "pms") return <MobilePMS onBack={back} initialProjectId={screen.projectId} />;
  if (screen.t === "mail") return <MobileMailCenter onBack={back} />;
  if (screen.t === "announcements") return <MobileAnnouncements onBack={back} />;
  if (screen.t === "inbox") return <MobileInbox onBack={back} onOpen={(n) => { const doc = (n as { doc_no?: string }).doc_no; if (doc) setScreen({ t: "so-detail", docNo: doc }); }} />;
  if (screen.t === "stub") return <Stub title={screen.title} onBack={back} />;

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {tab === "orders" && (
          <MobileSalesOrders
            onScan={() => setScreen({ t: "scan" })}
            onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })}
            onNew={() => setScreen({ t: "new-so", mode: "new" })}
          />
        )}
        {tab === "service" && <MobileServiceCase onBack={() => setTab("orders")} />}
        {tab === "calendar" && <MobileCalendar onOpenProject={(id) => setScreen({ t: "pms", projectId: id })} />}
        {tab === "profile" && <MobileProfile onLogout={logout} />}
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

