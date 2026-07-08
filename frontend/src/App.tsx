import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useAuth } from "./auth/AuthContext";
import { PageGuard } from "./auth/PageGuard";
import { Forbidden } from "./pages/Forbidden";
import { GlobalSearchProvider } from "./components/GlobalSearch";
import { NotificationsProvider } from "./hooks/useNotifications";
import { BrowserPushSink } from "./components/BrowserPushSink";
import { AnnouncementBanner } from "./components/AnnouncementBanner";
import { QuickActionsFAB } from "./components/QuickActionsFAB";
import { BreadcrumbsProvider } from "./hooks/useBreadcrumbs";
import { PageSkeleton, ChunkReloadBoundary } from "./components/RouteFallback";
import { NewVersionBanner } from "./components/NewVersionBanner";
import { IosInstallGuide } from "./components/IosInstallGuide";

// Route-level code splitting: every page becomes its own chunk, fetched on
// first visit, so the initial bundle carries only the shell. The .then()
// indirection adapts our named exports to React.lazy's default-export shape
// without touching the page files. Multi-page modules (ServiceCases, Projects)
// share one chunk.
const ServiceCases = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCases })));
const ServiceCaseDetail = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCaseDetail })));
const MyCases = lazy(() => import("./pages/MyCases").then((m) => ({ default: m.MyCases })));
const MyCaseDetail = lazy(() => import("./pages/MyCases").then((m) => ({ default: m.MyCaseDetail })));
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const ProjectDetail = lazy(() => import("./pages/Projects").then((m) => ({ default: m.ProjectDetail })));
// Sales Entries — rep-entered sales log + Director approval queue.
// Restored to the menu 2026-07-06 (stripped in the core-slim pass).
const Sales = lazy(() => import("./pages/Sales").then((m) => ({ default: m.Sales })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const Notifications = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })));
const Announcements = lazy(() => import("./pages/Announcements").then((m) => ({ default: m.Announcements })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Team = lazy(() => import("./pages/Team").then((m) => ({ default: m.Team })));
const SystemHealth = lazy(() => import("./pages/SystemHealth").then((m) => ({ default: m.SystemHealth })));
// Mail Center — in-ERP shared inbox (ported from Hookka). Inbox + thread detail;
// Compose is a modal opened from the inbox (no standalone route).
const MailInbox = lazy(() => import("./pages/MailCenter/Inbox").then((m) => ({ default: m.MailInbox })));
const MailThread = lazy(() => import("./pages/MailCenter/Thread").then((m) => ({ default: m.MailThread })));
// Ported 2990's SCM (furniture supply chain) — owner-gated under /scm/*.
// These are the VENDORED (wholesale-copied) 2990 pages, now the canonical /scm/*
// surface. The native pages/scm/* set was retired in the cutover.
const ScmSuppliersV2 = lazy(() => import("./pages/scm-v2/SuppliersV2Route"));
// Each list/detail page is a NAMED export wrapped at the route in <Scm2990Shell>
// (the Notify/Confirm/dialog-service providers).
const Scm2990Shell = lazy(() => import("./pages/scm-v2/Scm2990Shell"));
const ScmPurchaseOrdersV2 = lazy(() => import("./pages/scm-v2/PurchaseOrders").then((m) => ({ default: m.PurchaseOrders })));
const ScmPurchaseOrderNewV2 = lazy(() => import("./pages/scm-v2/PurchaseOrderNew").then((m) => ({ default: m.PurchaseOrderNew })));
const ScmPurchaseOrderFromSoV2 = lazy(() => import("./pages/scm-v2/PurchaseOrderFromSo").then((m) => ({ default: m.PurchaseOrderFromSo })));
const ScmPurchaseOrderDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseOrderDetail").then((m) => ({ default: m.PurchaseOrderDetail })));
// TEMP — vendored 2990's MRP + read/list pages (wave 2), parallel to native.
const ScmMrpV2 = lazy(() => import("./pages/scm-v2/Mrp").then((m) => ({ default: m.Mrp })));
const ScmAccountingV2 = lazy(() => import("./pages/scm-v2/Accounting").then((m) => ({ default: m.Accounting })));
const ScmOutstandingV2 = lazy(() => import("./pages/scm-v2/Outstanding").then((m) => ({ default: m.Outstanding })));
const ScmFabricTrackingV2 = lazy(() => import("./pages/scm-v2/FabricTracking").then((m) => ({ default: m.FabricTracking })));
const ScmWarehousesV2 = lazy(() => import("./pages/scm-v2/Warehouses").then((m) => ({ default: m.Warehouses })));
const ScmProductsV2 = lazy(() => import("./pages/scm-v2/Products").then((m) => ({ default: m.Products })));
const ScmProductModelsV2 = lazy(() => import("./pages/scm-v2/ProductModels").then((m) => ({ default: m.ProductModels })));
const ScmProductModelDetailV2 = lazy(() => import("./pages/scm-v2/ProductModelDetail").then((m) => ({ default: m.ProductModelDetail })));
const ScmGoodsReceivedV2 = lazy(() => import("./pages/scm-v2/GoodsReceived").then((m) => ({ default: m.GoodsReceived })));
const ScmGrnNewV2 = lazy(() => import("./pages/scm-v2/GrnNew").then((m) => ({ default: m.GrnNew })));
const ScmGrnFromPoV2 = lazy(() => import("./pages/scm-v2/GrnFromPo").then((m) => ({ default: m.GrnFromPo })));
const ScmGoodsReceivedDetailV2 = lazy(() => import("./pages/scm-v2/GoodsReceivedDetail").then((m) => ({ default: m.GoodsReceivedDetail })));
const ScmPurchaseInvoicesV2 = lazy(() => import("./pages/scm-v2/PurchaseInvoices").then((m) => ({ default: m.PurchaseInvoices })));
const ScmPurchaseInvoiceNewV2 = lazy(() => import("./pages/scm-v2/PurchaseInvoiceNew").then((m) => ({ default: m.PurchaseInvoiceNew })));
const ScmPurchaseInvoiceFromGrnV2 = lazy(() => import("./pages/scm-v2/PurchaseInvoiceFromGrn").then((m) => ({ default: m.PurchaseInvoiceFromGrn })));
const ScmPurchaseInvoiceDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseInvoiceDetail").then((m) => ({ default: m.PurchaseInvoiceDetail })));
const ScmStockAdjustmentsV2 = lazy(() => import("./pages/scm-v2/StockAdjustments").then((m) => ({ default: m.StockAdjustments })));
const ScmStockAdjustmentNewV2 = lazy(() => import("./pages/scm-v2/StockAdjustmentNew").then((m) => ({ default: m.StockAdjustmentNew })));
const ScmStockTransfersV2 = lazy(() => import("./pages/scm-v2/StockTransfers").then((m) => ({ default: m.StockTransfers })));
const ScmStockTransferNewV2 = lazy(() => import("./pages/scm-v2/StockTransferNew").then((m) => ({ default: m.StockTransferNew })));
const ScmStockTransferDetailV2 = lazy(() => import("./pages/scm-v2/StockTransferDetail").then((m) => ({ default: m.StockTransferDetail })));
const ScmStockTakesV2 = lazy(() => import("./pages/scm-v2/StockTakes").then((m) => ({ default: m.StockTakes })));
const ScmStockTakeNewV2 = lazy(() => import("./pages/scm-v2/StockTakeNew").then((m) => ({ default: m.StockTakeNew })));
const ScmStockTakeDetailV2 = lazy(() => import("./pages/scm-v2/StockTakeDetail").then((m) => ({ default: m.StockTakeDetail })));
// TEMP — vendored 2990's PR / Inventory / Stock Card / Supplier Detail / Drivers
// pages (this wave), parallel to the native /scm/* routes below.
const ScmPurchaseReturnsV2 = lazy(() => import("./pages/scm-v2/PurchaseReturnsList").then((m) => ({ default: m.PurchaseReturns })));
const ScmPurchaseReturnNewV2 = lazy(() => import("./pages/scm-v2/PurchaseReturnNew").then((m) => ({ default: m.PurchaseReturnNew })));
const ScmPurchaseReturnDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseReturnDetail").then((m) => ({ default: m.PurchaseReturnDetail })));
const ScmInventoryV2 = lazy(() => import("./pages/scm-v2/Inventory").then((m) => ({ default: m.Inventory })));
const ScmStockCardV2 = lazy(() => import("./pages/scm-v2/StockCard").then((m) => ({ default: m.StockCard })));
const ScmSupplierDetailV2 = lazy(() => import("./pages/scm-v2/SupplierDetail").then((m) => ({ default: m.SupplierDetail })));
const ScmDriversV2 = lazy(() => import("./pages/scm-v2/Drivers").then((m) => ({ default: m.Drivers })));
// Delivery Planning + TMS (Stage 3 — ported 2026-06-28 from 2990).
const ScmDeliveryPlanningV2 = lazy(() => import("./pages/scm-v2/DeliveryPlanning").then((m) => ({ default: m.DeliveryPlanning })));
const ScmDeliveryPlanningRegionsV2 = lazy(() => import("./pages/scm-v2/DeliveryPlanningRegions").then((m) => ({ default: m.DeliveryPlanningRegions })));
const ScmFleetV2 = lazy(() => import("./pages/scm-v2/Fleet").then((m) => ({ default: m.Fleet })));
const ScmLorryCapacityV2 = lazy(() => import("./pages/scm-v2/LorryCapacity").then((m) => ({ default: m.LorryCapacity })));
// Sales Order READ side (vendored 2990 list + detail + maintenance). New-SO
// configurator + SoFromProducts come in a later wave. NOTE: 2990 uses :docNo
// (not :id) for SO detail, and the literal /maintenance route MUST precede
// /:docNo so 'maintenance' isn't read as a doc number.
// Overview — Workspace home (P1 task-first dashboard).
const Overview = lazy(() => import("./pages/Overview").then((m) => ({ default: m.Overview })));
// Supply Chain Hub — section landing page (flattens the 3-level SCM nesting).
const ScmHub = lazy(() => import("./pages/ScmHub").then((m) => ({ default: m.ScmHub })));
const ScmSalesOrdersV2 = lazy(() => import("./pages/scm-v2/MfgSalesOrdersListV2").then((m) => ({ default: m.MfgSalesOrdersListV2 })));
const ScmSalesOrderMaintenanceV2 = lazy(() => import("./pages/scm-v2/SalesOrderMaintenance").then((m) => ({ default: m.SalesOrderMaintenance })));
const ScmSalesOrderNewV2 = lazy(() => import("./pages/scm-v2/SalesOrderNew").then((m) => ({ default: m.SalesOrderNew })));
const ScmSalesOrderNewGuidedV2 = lazy(() => import("./pages/scm-v2/SalesOrderNewGuided").then((m) => ({ default: m.SalesOrderNewGuided })));
const ScmSalesOrderNewFromProductsV2 = lazy(() => import("./pages/scm-v2/SalesOrderNewFromProducts").then((m) => ({ default: m.SalesOrderNewFromProducts })));
const ScmCategoriesV2 = lazy(() => import("./pages/scm-v2/Categories").then((m) => ({ default: m.Categories })));
const ScmSoFromProductsV2 = lazy(() => import("./pages/scm-v2/SoFromProducts").then((m) => ({ default: m.SoFromProducts })));
const ScmSalesOrderDetailV2 = lazy(() => import("./pages/scm-v2/SalesOrderDetailV2").then((m) => ({ default: m.SalesOrderDetailV2 })));
const ScmSoDetailListingV2 = lazy(() => import("./pages/scm-v2/SalesOrderDetailListing").then((m) => ({ default: m.SalesOrderDetailListing })));
const ScmDoDetailListingV2 = lazy(() => import("./pages/scm-v2/DeliveryOrderDetailListing").then((m) => ({ default: m.DeliveryOrderDetailListing })));
const ScmSiDetailListingV2 = lazy(() => import("./pages/scm-v2/SalesInvoiceDetailListing").then((m) => ({ default: m.SalesInvoiceDetailListing })));
const ScmDrDetailListingV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnDetailListing").then((m) => ({ default: m.DeliveryReturnDetailListing })));
const ScmDeliveryOrdersV2 = lazy(() => import("./pages/scm-v2/MfgDeliveryOrdersListV2").then((m) => ({ default: m.MfgDeliveryOrdersListV2 })));
const ScmDeliveryOrderNewV2 = lazy(() => import("./pages/scm-v2/DeliveryOrderNew").then((m) => ({ default: m.DeliveryOrderNew })));
const ScmDeliveryOrderFromSoV2 = lazy(() => import("./pages/scm-v2/DeliveryOrderFromSo").then((m) => ({ default: m.DeliveryOrderFromSo })));
const ScmDeliveryOrderDetailV2 = lazy(() => import("./pages/scm-v2/DeliveryOrderDetailV2").then((m) => ({ default: m.DeliveryOrderDetailV2 })));
const ScmSalesInvoicesV2 = lazy(() => import("./pages/scm-v2/SalesInvoicesListV2").then((m) => ({ default: m.SalesInvoicesListV2 })));
const ScmSalesInvoiceNewV2 = lazy(() => import("./pages/scm-v2/SalesInvoiceNew").then((m) => ({ default: m.SalesInvoiceNew })));
const ScmSalesInvoiceFromDoV2 = lazy(() => import("./pages/scm-v2/SalesInvoiceFromDo").then((m) => ({ default: m.SalesInvoiceFromDo })));
const ScmSalesInvoiceDetailV2 = lazy(() => import("./pages/scm-v2/SalesInvoiceDetailV2").then((m) => ({ default: m.SalesInvoiceDetailV2 })));
const ScmDeliveryReturnsV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnsListV2").then((m) => ({ default: m.DeliveryReturnsListV2 })));
const ScmDeliveryReturnNewV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnNew").then((m) => ({ default: m.DeliveryReturnNew })));
const ScmDeliveryReturnFromDoV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnFromDo").then((m) => ({ default: m.DeliveryReturnFromDo })));
const ScmDeliveryReturnDetailV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnDetailV2").then((m) => ({ default: m.DeliveryReturnDetailV2 })));
const ScmConsignmentOrdersV2 = lazy(() => import("./pages/scm-v2/ConsignmentOrders").then((m) => ({ default: m.ConsignmentOrders })));
const ScmConsignmentOrderNewV2 = lazy(() => import("./pages/scm-v2/ConsignmentOrderNew").then((m) => ({ default: m.ConsignmentOrderNew })));
const ScmConsignmentOrderDetailV2 = lazy(() => import("./pages/scm-v2/ConsignmentOrderDetail").then((m) => ({ default: m.ConsignmentOrderDetail })));
const ScmConsignmentNotesV2 = lazy(() => import("./pages/scm-v2/ConsignmentNotes").then((m) => ({ default: m.ConsignmentNotes })));
const ScmConsignmentNoteNewV2 = lazy(() => import("./pages/scm-v2/ConsignmentNoteNew").then((m) => ({ default: m.ConsignmentNoteNew })));
const ScmConsignmentNoteFromOrderV2 = lazy(() => import("./pages/scm-v2/ConsignmentNoteFromOrder").then((m) => ({ default: m.ConsignmentNoteFromOrder })));
const ScmConsignmentNoteDetailV2 = lazy(() => import("./pages/scm-v2/ConsignmentNoteDetail").then((m) => ({ default: m.ConsignmentNoteDetail })));
const ScmConsignmentReturnsV2 = lazy(() => import("./pages/scm-v2/ConsignmentReturns").then((m) => ({ default: m.ConsignmentReturns })));
const ScmConsignmentReturnNewV2 = lazy(() => import("./pages/scm-v2/ConsignmentReturnNew").then((m) => ({ default: m.ConsignmentReturnNew })));
const ScmConsignmentReturnFromNoteV2 = lazy(() => import("./pages/scm-v2/ConsignmentReturnFromNote").then((m) => ({ default: m.ConsignmentReturnFromNote })));
const ScmConsignmentReturnDetailV2 = lazy(() => import("./pages/scm-v2/ConsignmentReturnDetail").then((m) => ({ default: m.ConsignmentReturnDetail })));
const ScmPurchaseConsignmentOrdersV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentOrders").then((m) => ({ default: m.PurchaseConsignmentOrders })));
const ScmPurchaseConsignmentOrderNewV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentOrderNew").then((m) => ({ default: m.PurchaseConsignmentOrderNew })));
const ScmPurchaseConsignmentOrderDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentOrderDetail").then((m) => ({ default: m.PurchaseConsignmentOrderDetail })));
const ScmPurchaseConsignmentReceivesV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReceives").then((m) => ({ default: m.PurchaseConsignmentReceives })));
const ScmPurchaseConsignmentReceiveNewV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReceiveNew").then((m) => ({ default: m.PurchaseConsignmentReceiveNew })));
const ScmPurchaseConsignmentReceiveFromOrderV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReceiveFromOrder").then((m) => ({ default: m.PurchaseConsignmentReceiveFromOrder })));
const ScmPurchaseConsignmentReceiveDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReceiveDetail").then((m) => ({ default: m.PurchaseConsignmentReceiveDetail })));
const ScmPurchaseConsignmentReturnsV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReturns").then((m) => ({ default: m.PurchaseConsignmentReturns })));
const ScmPurchaseConsignmentReturnNewV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReturnNew").then((m) => ({ default: m.PurchaseConsignmentReturnNew })));
const ScmPurchaseConsignmentReturnFromReceiveV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReturnFromReceive").then((m) => ({ default: m.PurchaseConsignmentReturnFromReceive })));
const ScmPurchaseConsignmentReturnDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReturnDetail").then((m) => ({ default: m.PurchaseConsignmentReturnDetail })));

/**
 * Wraps a route element in a permission check. Failures render the
 * <Forbidden> page inline (URL preserved) so the user understands why
 * they were blocked — see frontend/src/pages/Forbidden.tsx.
 */
function Guard({
  perm,
  anyPerm,
  anyAccess,
  children,
}: {
  perm?: string;
  anyPerm?: string[];
  /** ADDITIVE page-access OR-gate. When present, the route also passes if
   *  ANY listed page-access key resolves to !== 'none'. Combined with `perm`
   *  / `anyPerm` via OR — used by the SCM routes so a per-position SCM grant
   *  unlocks its area WITHOUT removing the existing `scm.access` / `*` path. */
  anyAccess?: string[];
  children: React.ReactNode;
}) {
  const { can, pageAccess } = useAuth();
  // OR across all provided gates — pass if ANY is satisfied. (Previously each
  // gate could only DENY; with anyAccess the gates are alternatives, so a
  // grant on any one is sufficient.)
  const permOk = perm ? can(perm) : false;
  const anyPermOk = anyPerm ? anyPerm.some((p) => can(p)) : false;
  const anyAccessOk = anyAccess
    ? anyAccess.some((k) => pageAccess(k) !== "none")
    : false;
  if (permOk || anyPermOk || anyAccessOk) return <>{children}</>;
  const label =
    perm ?? anyPerm?.join(" / ") ?? anyAccess?.join(" / ") ?? "access";
  return <Forbidden page={label} />;
}

/**
 * SCM route guard — `scm.access` / `*` keep full access (unchanged); a
 * position granted the mapped SCM page-access area ALSO passes (additive).
 * `area` is one of the scm.<area> page keys. Thin wrapper over <Guard> so the
 * ~75 /scm/* routes stay a one-line change each.
 */
function ScmGuard({
  area,
  children,
}: {
  area: string;
  children: React.ReactNode;
}) {
  return (
    <Guard perm="scm.access" anyAccess={[area]}>
      {children}
    </Guard>
  );
}

export default function App() {
  return (
    <GlobalSearchProvider>
      <NotificationsProvider>
      <BreadcrumbsProvider>
      <BrowserPushSink />
      <AnnouncementBanner />
      <QuickActionsFAB />
      <NewVersionBanner />
      <IosInstallGuide />
      <Layout>
        <ChunkReloadBoundary>
        <Suspense fallback={<PageSkeleton />}>
        <Routes>
        {/* Landing → Overview workspace home (P1). */}
        <Route path="/" element={<Overview />} />
        <Route
          path="/assr"
          element={
            <PageGuard page="service_cases">
              <ServiceCases />
            </PageGuard>
          }
        />
        <Route
          path="/assr/:id"
          element={
            <PageGuard page="service_cases">
              <ServiceCaseDetail />
            </PageGuard>
          }
        />
        <Route
          path="/sales"
          element={
            <PageGuard page="sales">
              <Sales />
            </PageGuard>
          }
        />
        <Route
          path="/my-cases"
          element={
            <PageGuard page="service_cases">
              <MyCases />
            </PageGuard>
          }
        />
        <Route
          path="/my-cases/:id"
          element={
            <PageGuard page="service_cases">
              <>
                <MyCases />
                <MyCaseDetail />
              </>
            </PageGuard>
          }
        />
        <Route
          path="/projects"
          element={
            <PageGuard page="projects">
              <Projects />
            </PageGuard>
          }
        />
        <Route
          path="/projects/:id"
          element={
            <PageGuard page="projects.list">
              <ProjectDetail />
            </PageGuard>
          }
        />
        <Route
          path="/settings"
          element={
            <PageGuard page="settings" minLevel="full">
              <Settings />
            </PageGuard>
          }
        />
        <Route
          path="/system-health"
          element={
            <PageGuard page="system_health">
              <SystemHealth />
            </PageGuard>
          }
        />
        <Route
          path="/team"
          element={
            <PageGuard page="team">
              <Team />
            </PageGuard>
          }
        />
        {/* ── Announcements — office-wide notices + read receipts. List page
            gated on announcements.read; create/edit/remind/delete also need
            announcements.write (enforced server-side). ── */}
        <Route
          path="/announcements"
          element={
            <Guard perm="announcements.read">
              <Announcements />
            </Guard>
          }
        />
        {/* ── Mail Center — shared inbox. Permission-gated on mail_center.read
            (the per-user mailbox scope is enforced server-side; reads/replies
            aren't gated by a permission key, only by mailbox ownership). The
            literal /mail-center route precedes /mail-center/:id. Compose is a
            modal opened from the inbox, not its own route. ── */}
        <Route
          path="/mail-center"
          element={
            <Guard perm="mail_center.read">
              <MailInbox />
            </Guard>
          }
        />
        <Route
          path="/mail-center/:id"
          element={
            <Guard perm="mail_center.read">
              <MailThread />
            </Guard>
          }
        />
        {/* ── Supply Chain (vendored 2990's SCM) — scm.access-gated /scm/*;
            Owner / IT Admin pass via their "*" wildcard (can() short-circuits "*"). ── */}
        <Route
          path="/scm/suppliers"
          element={
            <ScmGuard area="scm.procurement.suppliers">
              <ScmSuppliersV2 />
            </ScmGuard>
          }
        />
        {/* Vendored 2990's Purchase Order pages. /new + /from-so precede /:id so
            the literal segments match before the param route. Each page is wrapped
            in <Scm2990Shell> for the Notify/Confirm/dialog-service providers. */}
        <Route path="/scm/purchase-orders" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPurchaseOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-orders/new" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPurchaseOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-orders/from-so" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPurchaseOrderFromSoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-orders/:id" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPurchaseOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* Vendored 2990's MRP + read/list pages. Each wrapped in <Scm2990Shell>.
            product-models list precedes /:id so the literal segment matches first. */}
        <Route path="/scm/mrp" element={<ScmGuard area="scm.procurement.mrp"><Scm2990Shell><ScmMrpV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/accounting" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmAccountingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/outstanding" element={<ScmGuard area="scm.finance.outstanding"><Scm2990Shell><ScmOutstandingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/fabric-tracking" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmFabricTrackingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/warehouses" element={<ScmGuard area="scm.warehouse.inventory"><Scm2990Shell><ScmWarehousesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/products" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmProductsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/categories" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmCategoriesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/product-models" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmProductModelsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/product-models/:id" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmProductModelDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* TEMP — vendored 2990's GRN + Purchase Invoice pages (wave 3), parallel
            to the native /scm/* below. Each wrapped in <Scm2990Shell>. Literal
            segments (/new, /from-po, /from-grn) precede /:id so they match first. */}
        <Route path="/scm/grns" element={<ScmGuard area="scm.procurement.grn"><Scm2990Shell><ScmGoodsReceivedV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/grns/new" element={<ScmGuard area="scm.procurement.grn"><Scm2990Shell><ScmGrnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/grns/from-po" element={<ScmGuard area="scm.procurement.grn"><Scm2990Shell><ScmGrnFromPoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/grns/:id" element={<ScmGuard area="scm.procurement.grn"><Scm2990Shell><ScmGoodsReceivedDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-invoices" element={<ScmGuard area="scm.procurement.pi"><Scm2990Shell><ScmPurchaseInvoicesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-invoices/new" element={<ScmGuard area="scm.procurement.pi"><Scm2990Shell><ScmPurchaseInvoiceNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-invoices/from-grn" element={<ScmGuard area="scm.procurement.pi"><Scm2990Shell><ScmPurchaseInvoiceFromGrnV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-invoices/:id" element={<ScmGuard area="scm.procurement.pi"><Scm2990Shell><ScmPurchaseInvoiceDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* TEMP — vendored 2990's stock-movement pages (wave 4: Adjustments /
            Transfers / Takes), parallel to the native /scm/* below. Each wrapped
            in <Scm2990Shell>. Literal /new precedes /:id so it matches first. */}
        <Route path="/scm/stock-adjustments" element={<ScmGuard area="scm.warehouse.adjustments"><Scm2990Shell><ScmStockAdjustmentsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-adjustments/new" element={<ScmGuard area="scm.warehouse.adjustments"><Scm2990Shell><ScmStockAdjustmentNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-transfers" element={<ScmGuard area="scm.warehouse.transfers"><Scm2990Shell><ScmStockTransfersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-transfers/new" element={<ScmGuard area="scm.warehouse.transfers"><Scm2990Shell><ScmStockTransferNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-transfers/:id" element={<ScmGuard area="scm.warehouse.transfers"><Scm2990Shell><ScmStockTransferDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-takes" element={<ScmGuard area="scm.warehouse.stock_take"><Scm2990Shell><ScmStockTakesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-takes/new" element={<ScmGuard area="scm.warehouse.stock_take"><Scm2990Shell><ScmStockTakeNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-takes/:id" element={<ScmGuard area="scm.warehouse.stock_take"><Scm2990Shell><ScmStockTakeDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* TEMP — vendored 2990's PR / Inventory / Stock Card / Supplier Detail /
            Drivers pages (this wave), parallel to the native /scm/* below. Each
            wrapped in <Scm2990Shell>. Literal segments (/new, /stock-card)
            precede the /:id routes so they match first. */}
        <Route path="/scm/purchase-returns" element={<ScmGuard area="scm.procurement.pr"><Scm2990Shell><ScmPurchaseReturnsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-returns/new" element={<ScmGuard area="scm.procurement.pr"><Scm2990Shell><ScmPurchaseReturnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-returns/:id" element={<ScmGuard area="scm.procurement.pr"><Scm2990Shell><ScmPurchaseReturnDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/inventory" element={<ScmGuard area="scm.warehouse.inventory"><Scm2990Shell><ScmInventoryV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/inventory/stock-card/:productCode" element={<ScmGuard area="scm.warehouse.inventory"><Scm2990Shell><ScmStockCardV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/suppliers/:id" element={<ScmGuard area="scm.procurement.suppliers"><Scm2990Shell><ScmSupplierDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/drivers" element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDriversV2 /></Scm2990Shell></ScmGuard>} />
        {/* Delivery Planning + TMS Stage 3 — all under the existing scm.transportation.drivers area. */}
        <Route path="/scm/delivery-planning"         element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDeliveryPlanningV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-planning-regions" element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDeliveryPlanningRegionsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/fleet"                     element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmFleetV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/lorry-capacity"            element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmLorryCapacityV2 /></Scm2990Shell></ScmGuard>} />
        {/* Supply Chain Hub — section landing page (main app layout, NOT the 2990 shell). */}
        <Route path="/scm" element={<ScmGuard area="scm"><ScmHub /></ScmGuard>} />
        {/* Sales Orders READ side (vendored). The literal /maintenance route
            MUST precede /:docNo so 'maintenance' isn't caught as a doc number.
            2990 uses :docNo (not :id) for the SO detail. */}
        <Route path="/scm/sales-orders" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSalesOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/maintenance" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSalesOrderMaintenanceV2 /></Scm2990Shell></ScmGuard>} />
        {/* Literal /new + /generate MUST precede /:docNo so they match first. */}
        <Route path="/scm/sales-orders/new" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSalesOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/new/guided" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSalesOrderNewGuidedV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/new/from-products" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSalesOrderNewFromProductsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/generate" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSoFromProductsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/:docNo" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSalesOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* SCM Reports v2 — AutoCount-style detail listings. Each wrapped in <Scm2990Shell>. */}
        <Route path="/scm/reports/sales-order-detail-listing" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSoDetailListingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/reports/delivery-order-detail-listing" element={<ScmGuard area="scm.sales.delivery"><Scm2990Shell><ScmDoDetailListingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/reports/sales-invoice-detail-listing" element={<ScmGuard area="scm.sales.invoices"><Scm2990Shell><ScmSiDetailListingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/reports/delivery-return-detail-listing" element={<ScmGuard area="scm.sales.returns"><Scm2990Shell><ScmDrDetailListingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-orders" element={<ScmGuard area="scm.sales.delivery"><Scm2990Shell><ScmDeliveryOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-orders/new" element={<ScmGuard area="scm.sales.delivery"><Scm2990Shell><ScmDeliveryOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-orders/from-so" element={<ScmGuard area="scm.sales.delivery"><Scm2990Shell><ScmDeliveryOrderFromSoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-orders/:id" element={<ScmGuard area="scm.sales.delivery"><Scm2990Shell><ScmDeliveryOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-invoices" element={<ScmGuard area="scm.sales.invoices"><Scm2990Shell><ScmSalesInvoicesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-invoices/new" element={<ScmGuard area="scm.sales.invoices"><Scm2990Shell><ScmSalesInvoiceNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-invoices/from-do" element={<ScmGuard area="scm.sales.invoices"><Scm2990Shell><ScmSalesInvoiceFromDoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-invoices/:id" element={<ScmGuard area="scm.sales.invoices"><Scm2990Shell><ScmSalesInvoiceDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-returns" element={<ScmGuard area="scm.sales.returns"><Scm2990Shell><ScmDeliveryReturnsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-returns/new" element={<ScmGuard area="scm.sales.returns"><Scm2990Shell><ScmDeliveryReturnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-returns/from-do" element={<ScmGuard area="scm.sales.returns"><Scm2990Shell><ScmDeliveryReturnFromDoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-returns/:id" element={<ScmGuard area="scm.sales.returns"><Scm2990Shell><ScmDeliveryReturnDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-orders" element={<ScmGuard area="scm.consignment.orders"><Scm2990Shell><ScmConsignmentOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-orders/new" element={<ScmGuard area="scm.consignment.orders"><Scm2990Shell><ScmConsignmentOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-orders/:docNo" element={<ScmGuard area="scm.consignment.orders"><Scm2990Shell><ScmConsignmentOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-notes" element={<ScmGuard area="scm.consignment.notes"><Scm2990Shell><ScmConsignmentNotesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-notes/new" element={<ScmGuard area="scm.consignment.notes"><Scm2990Shell><ScmConsignmentNoteNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-notes/from-order" element={<ScmGuard area="scm.consignment.notes"><Scm2990Shell><ScmConsignmentNoteFromOrderV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-notes/:id" element={<ScmGuard area="scm.consignment.notes"><Scm2990Shell><ScmConsignmentNoteDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* Consignment Returns (DR-clone) + Purchase Consignment Orders (PO-clone),
            vendored 2990 pages wrapped in <Scm2990Shell>. Literal segments
            (/new, /from-note) precede /:id so they match first. */}
        <Route path="/scm/consignment-returns" element={<ScmGuard area="scm.consignment.returns"><Scm2990Shell><ScmConsignmentReturnsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-returns/new" element={<ScmGuard area="scm.consignment.returns"><Scm2990Shell><ScmConsignmentReturnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-returns/from-note" element={<ScmGuard area="scm.consignment.returns"><Scm2990Shell><ScmConsignmentReturnFromNoteV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-returns/:id" element={<ScmGuard area="scm.consignment.returns"><Scm2990Shell><ScmConsignmentReturnDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-orders" element={<ScmGuard area="scm.consignment.po_orders"><Scm2990Shell><ScmPurchaseConsignmentOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-orders/new" element={<ScmGuard area="scm.consignment.po_orders"><Scm2990Shell><ScmPurchaseConsignmentOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-orders/:id" element={<ScmGuard area="scm.consignment.po_orders"><Scm2990Shell><ScmPurchaseConsignmentOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-receives" element={<ScmGuard area="scm.consignment.po_receives"><Scm2990Shell><ScmPurchaseConsignmentReceivesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-receives/new" element={<ScmGuard area="scm.consignment.po_receives"><Scm2990Shell><ScmPurchaseConsignmentReceiveNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-receives/from-pc-order" element={<ScmGuard area="scm.consignment.po_receives"><Scm2990Shell><ScmPurchaseConsignmentReceiveFromOrderV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-receives/:id" element={<ScmGuard area="scm.consignment.po_receives"><Scm2990Shell><ScmPurchaseConsignmentReceiveDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-returns" element={<ScmGuard area="scm.consignment.po_returns"><Scm2990Shell><ScmPurchaseConsignmentReturnsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-returns/new" element={<ScmGuard area="scm.consignment.po_returns"><Scm2990Shell><ScmPurchaseConsignmentReturnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-returns/from-receive" element={<ScmGuard area="scm.consignment.po_returns"><Scm2990Shell><ScmPurchaseConsignmentReturnFromReceiveV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-returns/:id" element={<ScmGuard area="scm.consignment.po_returns"><Scm2990Shell><ScmPurchaseConsignmentReturnDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* Maintenance — no standalone vendored page; the vendored Products page
            hosts the Maintenance tab. The "Maintenance" nav item resolves here. */}
        <Route path="/scm/maintenance" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmProductsV2 /></Scm2990Shell></ScmGuard>} />
        {/* Inbox — the mobile bottom-nav Inbox tab + the desktop bell's
            "view all" land here. Reuses the shared NotificationsProvider
            feed. Gated on projects.read (same gate as the bell + the mobile
            menu's Inbox card). */}
        <Route
          path="/notifications"
          element={
            <Guard perm="projects.read">
              <Notifications />
            </Guard>
          }
        />
        {/* Legacy /roles → Team page's Roles tab */}
        <Route
          path="/roles"
          element={<Navigate to="/team?tab=roles" replace />}
        />
        <Route path="/profile" element={<Profile />} />
        <Route path="*" element={<Forbidden kind="not-found" />} />
        </Routes>
        </Suspense>
        </ChunkReloadBoundary>
      </Layout>
      </BreadcrumbsProvider>
      </NotificationsProvider>
    </GlobalSearchProvider>
  );
}
