import { useEffect, useState } from "react";
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
  // The three from-source create paths desktop supports but mobile lacked:
  // Sales Return from a DO, Purchase Invoice + Purchase Return from a GRN.
  "delivery-returns": "dr",
  "purchase-invoices": "pi",
  "purchase-returns": "pr",
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
// Menu icon paths — ported VERBATIM from the design's `var ICONS` map
// (Houzs Mobile.html). Rendered inside a shared 24x24 stroke SVG (see MIcon).
const MENU_ICONS: Record<string, React.ReactNode> = {
  list: <path d="M5 4h14M5 9h14M5 14h14M5 19h9" />,
  cart: <><path d="M2 3h2l2.4 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 6H6" /><circle cx="9" cy="20" r="1" /><circle cx="18" cy="20" r="1" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  box: <><path d="M21 8 12 3 3 8v8l9 5 9-5Z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" /></>,
  truck: <><path d="M10 17h4V5H2v12h3" /><path d="M20 17h2v-3.3a4 4 0 0 0-1.2-2.8L19 9h-5v8h1" /><circle cx="7.5" cy="17.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  wrench: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7Z" />,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z" /><path d="m9 12 2 2 4-4" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /></>,
  zap: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m2 6 10 7 10-7" /></>,
  mega: <><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M16 8a4 4 0 0 1 0 8" /></>,
  receipt: <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M8 7h8M8 11h8" /></>,
  chart: <><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="7" /><rect x="12" y="6" width="3" height="11" /><rect x="17" y="13" width="3" height="4" /></>,
  pkg: <><path d="M16 16l-4 2-4-2V8l4-2 4 2Z" /><path d="M12 6v12" /></>,
  sofa: <><path d="M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3" /><path d="M2 13a2 2 0 0 1 4 0v3h12v-3a2 2 0 0 1 4 0v5H2Z" /></>,
  warehouse: <><path d="M3 21V8l9-5 9 5v13" /><path d="M7 21v-8h10v8" /></>,
};

const MOBILE_MENU_GROUPS: { group: string; icon: string; items: { to: string; label: string; icon: string }[] }[] = [
  { group: "Sales & Finance", icon: "cart", items: [
    { to: "/scm/sales-orders", label: "Sales Orders", icon: "cart" },
    { to: "/scm/delivery-orders", label: "Delivery Orders", icon: "send" },
    { to: "/scm/sales-invoices", label: "Sales Invoices", icon: "receipt" },
    { to: "/scm/delivery-returns", label: "Sales Returns", icon: "box" },
  ]},
  { group: "Projects · PMS", icon: "folder", items: [
    { to: "/projects", label: "Projects", icon: "folder" },
  ]},
  { group: "After-sales", icon: "zap", items: [
    { to: "/assr", label: "Service Case", icon: "zap" },
  ]},
  { group: "Procurement & MRP", icon: "pkg", items: [
    { to: "/scm/mrp", label: "MRP · Stock Status", icon: "chart" },
    { to: "/scm/purchase-orders", label: "Purchase Orders", icon: "list" },
    { to: "/scm/grns", label: "Goods Receipt", icon: "pkg" },
    { to: "/scm/purchase-invoices", label: "Purchase Invoices", icon: "receipt" },
    { to: "/scm/purchase-returns", label: "Purchase Returns", icon: "box" },
    { to: "/scm/products", label: "Products & Maintenance", icon: "sofa" },
    { to: "/scm/suppliers", label: "Suppliers", icon: "truck" },
  ]},
  { group: "Logistics", icon: "truck", items: [
    { to: "/scm/delivery-planning", label: "Delivery Planning", icon: "send" },
    { to: "/scm/fleet", label: "Fleet", icon: "truck" },
    { to: "/scm/drivers", label: "Drivers", icon: "truck" },
  ]},
  { group: "Warehouse", icon: "warehouse", items: [
    { to: "/scm/warehouses", label: "Warehouse", icon: "warehouse" },
    { to: "/scm/inventory", label: "Inventory", icon: "box" },
  ]},
  { group: "Organisation", icon: "users", items: [
    { to: "/activity-inbox", label: "Inbox", icon: "mail" },
    { to: "/team?tab=members", label: "Members", icon: "users" },
    { to: "/team?tab=positions", label: "Positions", icon: "shield" },
    { to: "/team?tab=departments", label: "Departments", icon: "box" },
    { to: "/mail-center", label: "Mail Center", icon: "mail" },
    { to: "/announcements", label: "Announcements", icon: "mega" },
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
  const [tab, setTab] = useState<Tab>("orders");
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>({ t: "tab" });
  const back = () => setScreen({ t: "tab" });

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
    .map((g) => ({ group: g.group, icon: g.icon, items: g.items.filter((it) => allowed(it.to)) }))
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
  if (screen.t === "so-detail") return <MobileSODetail docNo={screen.docNo} onBack={back} onEdit={(d) => setScreen({ t: "new-so", mode: "edit", docNo: d })} onIssueDo={(d) => setScreen({ t: "convert", key: "delivery-orders-mfg", title: "Delivery Orders", target: "do", initialSourceId: d })} />;
  if (screen.t === "new-so") return <MobileNewSO mode={screen.mode} docNo={screen.docNo} scanPrefill={screen.scanPrefill} onBack={back} onSaved={(d) => setScreen({ t: "so-detail", docNo: d })} />;
  if (screen.t === "scan") return <MobileScan onBack={back} onExtracted={(prefill) => setScreen({ t: "new-so", mode: "new", scanPrefill: prefill })} />;
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
    // Launched from an SO detail (Issue Delivery Order) → return to that SO
    // afterwards so the operator sees the updated delivery state. Launched from
    // a module list ("+ New") → return to that list.
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
            <button className="disc" onClick={() => setMenuOpen(true)} aria-label="Menu">
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
              {menuGroups.map(({ group, icon, items }) => (
                <div className="mgroup" key={group}>
                  <div className="mgh">
                    <MIcon name={icon} color="#a16a2e" size={12} />
                    <span className="gl">{group}</span>
                    <span className="gr" />
                  </div>
                  <div className="mgrid">
                    {items.map((it) => (
                      <button className="mcard" key={it.to} onClick={() => openRoute(it.to, it.label)}>
                        <span className="mi"><MIcon name={it.icon} color="#16695f" size={16} /></span>
                        <span className="ml">{it.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {menuGroups.length === 0 && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "24px 0" }}>No modules available for your position.</div>}
            </div>
            <div className="sheet-foot">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z" /></svg>
              <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase", color: "#767b6e" }}>Houzs ERP</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Menu tile icon — mirrors the design's `micon()` (24x24 stroke SVG, the
 *  path(s) pulled from MENU_ICONS). */
function MIcon({ name, color, size }: { name: string; color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {MENU_ICONS[name] ?? null}
    </svg>
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

