import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation, type To } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DriverLayout } from "./components/DriverLayout";
import { useAuth } from "./auth/AuthContext";
import { PageGuard } from "./auth/PageGuard";
import { Forbidden } from "./pages/Forbidden";
import { GlobalSearchProvider } from "./components/GlobalSearch";
import { NotificationsProvider } from "./hooks/useNotifications";
import { BrowserPushSink } from "./components/BrowserPushSink";
import { QuickActionsFAB } from "./components/QuickActionsFAB";
import { BreadcrumbsProvider } from "./hooks/useBreadcrumbs";
import { PageSkeleton, ChunkReloadBoundary } from "./components/RouteFallback";

// Route-level code splitting: every page becomes its own chunk, fetched on
// first visit, so the initial bundle carries only the shell. The .then()
// indirection adapts our named exports to React.lazy's default-export shape
// without touching the page files. Multi-page modules (PurchaseOrders,
// ServiceCases, Projects) share one chunk.
const Overview = lazy(() => import("./pages/Overview").then((m) => ({ default: m.Overview })));
const Orders = lazy(() => import("./pages/Orders").then((m) => ({ default: m.Orders })));
const OrderDetail = lazy(() => import("./pages/OrderDetail").then((m) => ({ default: m.OrderDetail })));
const SalesOrderItems = lazy(() => import("./pages/SalesOrderItems").then((m) => ({ default: m.SalesOrderItems })));
const DeliveryOrders = lazy(() => import("./pages/DeliveryOrders").then((m) => ({ default: m.DeliveryOrders })));
const PurchaseOrders = lazy(() => import("./pages/PurchaseOrders").then((m) => ({ default: m.PurchaseOrders })));
const PurchaseOrderDetail = lazy(() => import("./pages/PurchaseOrders").then((m) => ({ default: m.PurchaseOrderDetail })));
const CreditorDetail = lazy(() => import("./pages/CreditorDetail").then((m) => ({ default: m.CreditorDetail })));
const Suppliers = lazy(() => import("./pages/Suppliers").then((m) => ({ default: m.Suppliers })));
const SupplierDetail = lazy(() => import("./pages/SupplierDetail").then((m) => ({ default: m.SupplierDetail })));
// SCM 1:1 clone — Purchase Orders (pages/scm/*). DISTINCT names from the
// AutoCount PurchaseOrders above (different module: ./pages/scm/PurchaseOrders).
const ScmPurchaseOrders = lazy(() => import("./pages/scm/PurchaseOrders").then((m) => ({ default: m.PurchaseOrders })));
const ScmPurchaseOrderDetail = lazy(() => import("./pages/scm/PurchaseOrderDetail").then((m) => ({ default: m.PurchaseOrderDetail })));
const ScmPurchaseOrderNew = lazy(() => import("./pages/scm/PurchaseOrderNew").then((m) => ({ default: m.PurchaseOrderNew })));
const ScmPurchaseOrderFromSo = lazy(() => import("./pages/scm/PurchaseOrderFromSo").then((m) => ({ default: m.PurchaseOrderFromSo })));
// SCM 1:1 clone — Inventory + Warehouse (pages/scm/*). DISTINCT routes from the
// live AutoCount surface (no frontend /inventory, /warehouses, /stock-* pages
// exist yet — all paths are free).
const ScmInventory = lazy(() => import("./pages/scm/Inventory").then((m) => ({ default: m.Inventory })));
const ScmStockCard = lazy(() => import("./pages/scm/StockCard").then((m) => ({ default: m.StockCard })));
const ScmStockAdjustments = lazy(() => import("./pages/scm/StockAdjustments").then((m) => ({ default: m.StockAdjustments })));
const ScmStockAdjustmentNew = lazy(() => import("./pages/scm/StockAdjustmentNew").then((m) => ({ default: m.StockAdjustmentNew })));
const ScmWarehouses = lazy(() => import("./pages/scm/Warehouses").then((m) => ({ default: m.Warehouses })));
// SCM 1:1 clone — Goods Receipt (GRN) (pages/scm/*). No AutoCount /grns surface.
const ScmGoodsReceived = lazy(() => import("./pages/scm/GoodsReceivedList").then((m) => ({ default: m.GoodsReceived })));
const ScmGoodsReceivedDetail = lazy(() => import("./pages/scm/GoodsReceivedDetail").then((m) => ({ default: m.GoodsReceivedDetail })));
const ScmGrnNew = lazy(() => import("./pages/scm/GrnNew").then((m) => ({ default: m.GrnNew })));
const ScmGrnFromPo = lazy(() => import("./pages/scm/GrnFromPo").then((m) => ({ default: m.GrnFromPo })));
// SCM 1:1 clone — Purchase Invoice + Purchase Return (pages/scm/*). No AutoCount
// surface for either; all paths are free.
const ScmPurchaseInvoices = lazy(() => import("./pages/scm/PurchaseInvoicesList").then((m) => ({ default: m.PurchaseInvoices })));
const ScmPurchaseInvoiceNew = lazy(() => import("./pages/scm/PurchaseInvoiceNew").then((m) => ({ default: m.PurchaseInvoiceNew })));
const ScmPurchaseInvoiceFromGrn = lazy(() => import("./pages/scm/PurchaseInvoiceFromGrn").then((m) => ({ default: m.PurchaseInvoiceFromGrn })));
const ScmPurchaseInvoiceDetail = lazy(() => import("./pages/scm/PurchaseInvoiceDetail").then((m) => ({ default: m.PurchaseInvoiceDetail })));
const ScmPurchaseReturns = lazy(() => import("./pages/scm/PurchaseReturnsList").then((m) => ({ default: m.PurchaseReturns })));
const ScmPurchaseReturnNew = lazy(() => import("./pages/scm/PurchaseReturnNew").then((m) => ({ default: m.PurchaseReturnNew })));
const ScmPurchaseReturnDetail = lazy(() => import("./pages/scm/PurchaseReturnDetail").then((m) => ({ default: m.PurchaseReturnDetail })));
// SCM 1:1 clone — Stock Transfers + Stock Takes (pages/scm/*). No AutoCount
// /stock-transfers or /stock-takes surface -> distinct routes.
const ScmStockTransfers = lazy(() => import("./pages/scm/StockTransfers").then((m) => ({ default: m.StockTransfers })));
const ScmStockTransferNew = lazy(() => import("./pages/scm/StockTransferNew").then((m) => ({ default: m.StockTransferNew })));
const ScmStockTransferDetail = lazy(() => import("./pages/scm/StockTransferDetail").then((m) => ({ default: m.StockTransferDetail })));
const ScmStockTakes = lazy(() => import("./pages/scm/StockTakes").then((m) => ({ default: m.StockTakes })));
const ScmStockTakeNew = lazy(() => import("./pages/scm/StockTakeNew").then((m) => ({ default: m.StockTakeNew })));
const ScmStockTakeDetail = lazy(() => import("./pages/scm/StockTakeDetail").then((m) => ({ default: m.StockTakeDetail })));
// SCM 1:1 clone — Sales Orders (pages/scm/*). Houzs has `sales_orders` (AutoCount,
// different name) + the existing /orders + /sales routes -> distinct /sales-orders.
const ScmSalesOrders = lazy(() => import("./pages/scm/MfgSalesOrdersList").then((m) => ({ default: m.MfgSalesOrders })));
const ScmSalesOrderNew = lazy(() => import("./pages/scm/SalesOrderNew").then((m) => ({ default: m.SalesOrderNew })));
const ScmSalesOrderDetail = lazy(() => import("./pages/scm/SalesOrderDetail").then((m) => ({ default: m.SalesOrderDetail })));
// SCM 1:1 clone — Delivery Orders + Sales Invoices + Delivery Returns (order-to-
// cash downstream, pages/scm/*). DISTINCT from the AutoCount DeliveryOrders page.
const ScmDeliveryOrders = lazy(() => import("./pages/scm/DeliveryOrdersList").then((m) => ({ default: m.MfgDeliveryOrders })));
const ScmDeliveryOrderFromSo = lazy(() => import("./pages/scm/DeliveryOrderFromSo").then((m) => ({ default: m.DeliveryOrderFromSo })));
const ScmDeliveryOrderDetail = lazy(() => import("./pages/scm/DeliveryOrderDetail").then((m) => ({ default: m.DeliveryOrderDetail })));
const ScmSalesInvoices = lazy(() => import("./pages/scm/SalesInvoicesList").then((m) => ({ default: m.SalesInvoices })));
const ScmSalesInvoiceFromDo = lazy(() => import("./pages/scm/SalesInvoiceFromDo").then((m) => ({ default: m.SalesInvoiceFromDo })));
const ScmSalesInvoiceDetail = lazy(() => import("./pages/scm/SalesInvoiceDetail").then((m) => ({ default: m.SalesInvoiceDetail })));
const ScmDeliveryReturns = lazy(() => import("./pages/scm/DeliveryReturnsList").then((m) => ({ default: m.DeliveryReturns })));
const ScmDeliveryReturnFromDo = lazy(() => import("./pages/scm/DeliveryReturnFromDo").then((m) => ({ default: m.DeliveryReturnFromDo })));
const ScmDeliveryReturnDetail = lazy(() => import("./pages/scm/DeliveryReturnDetail").then((m) => ({ default: m.DeliveryReturnDetail })));
// SCM 1:1 clone — CONSIGNMENT (last doc-flow group), PURCHASE side (pages/scm/*).
// PC Order -> PC Receive (inventory IN) -> PC Return (inventory OUT). No AutoCount
// collision. SALES-consignment (notes/returns/orders) lands in a follow-up.
const ScmPcOrders = lazy(() => import("./pages/scm/PurchaseConsignmentOrders").then((m) => ({ default: m.PurchaseConsignmentOrders })));
const ScmPcOrderNew = lazy(() => import("./pages/scm/PurchaseConsignmentOrderNew").then((m) => ({ default: m.PurchaseConsignmentOrderNew })));
const ScmPcOrderDetail = lazy(() => import("./pages/scm/PurchaseConsignmentOrderDetail").then((m) => ({ default: m.PurchaseConsignmentOrderDetail })));
const ScmPcReceives = lazy(() => import("./pages/scm/PurchaseConsignmentReceives").then((m) => ({ default: m.PurchaseConsignmentReceives })));
const ScmPcReceiveFromOrder = lazy(() => import("./pages/scm/PurchaseConsignmentReceiveFromOrder").then((m) => ({ default: m.PurchaseConsignmentReceiveFromOrder })));
const ScmPcReceiveNew = lazy(() => import("./pages/scm/PurchaseConsignmentReceiveNew").then((m) => ({ default: m.PurchaseConsignmentReceiveNew })));
const ScmPcReceiveDetail = lazy(() => import("./pages/scm/PurchaseConsignmentReceiveDetail").then((m) => ({ default: m.PurchaseConsignmentReceiveDetail })));
const ScmPcReturns = lazy(() => import("./pages/scm/PurchaseConsignmentReturns").then((m) => ({ default: m.PurchaseConsignmentReturns })));
const ScmPcReturnFromReceive = lazy(() => import("./pages/scm/PurchaseConsignmentReturnFromReceive").then((m) => ({ default: m.PurchaseConsignmentReturnFromReceive })));
const ScmPcReturnNew = lazy(() => import("./pages/scm/PurchaseConsignmentReturnNew").then((m) => ({ default: m.PurchaseConsignmentReturnNew })));
const ScmPcReturnDetail = lazy(() => import("./pages/scm/PurchaseConsignmentReturnDetail").then((m) => ({ default: m.PurchaseConsignmentReturnDetail })));
// SCM 1:1 clone — CONSIGNMENT, SALES side (#67 part 2, pages/scm/*). Consignment
// Order (order only) -> Consignment Note (inventory OUT, CS_DO) -> Consignment
// Return (inventory IN, CS_DR). No AutoCount collision.
const ScmCoOrders = lazy(() => import("./pages/scm/ConsignmentOrders").then((m) => ({ default: m.ConsignmentOrders })));
const ScmCoOrderNew = lazy(() => import("./pages/scm/ConsignmentOrderNew").then((m) => ({ default: m.ConsignmentOrderNew })));
const ScmCoOrderDetail = lazy(() => import("./pages/scm/ConsignmentOrderDetail").then((m) => ({ default: m.ConsignmentOrderDetail })));
const ScmCnNotes = lazy(() => import("./pages/scm/ConsignmentNotes").then((m) => ({ default: m.ConsignmentNotes })));
const ScmCnNoteFromOrder = lazy(() => import("./pages/scm/ConsignmentNoteFromOrder").then((m) => ({ default: m.ConsignmentNoteFromOrder })));
const ScmCnNoteNew = lazy(() => import("./pages/scm/ConsignmentNoteNew").then((m) => ({ default: m.ConsignmentNoteNew })));
const ScmCnNoteDetail = lazy(() => import("./pages/scm/ConsignmentNoteDetail").then((m) => ({ default: m.ConsignmentNoteDetail })));
const ScmCrReturns = lazy(() => import("./pages/scm/ConsignmentReturns").then((m) => ({ default: m.ConsignmentReturns })));
const ScmCrReturnFromNote = lazy(() => import("./pages/scm/ConsignmentReturnFromNote").then((m) => ({ default: m.ConsignmentReturnFromNote })));
const ScmCrReturnNew = lazy(() => import("./pages/scm/ConsignmentReturnNew").then((m) => ({ default: m.ConsignmentReturnNew })));
const ScmCrReturnDetail = lazy(() => import("./pages/scm/ConsignmentReturnDetail").then((m) => ({ default: m.ConsignmentReturnDetail })));
const ServiceCases = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCases })));
const ServiceCaseDetail = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCaseDetail })));
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const ProjectDetail = lazy(() => import("./pages/Projects").then((m) => ({ default: m.ProjectDetail })));
const Sales = lazy(() => import("./pages/Sales").then((m) => ({ default: m.Sales })));
const Notifications = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Team = lazy(() => import("./pages/Team").then((m) => ({ default: m.Team })));
const SystemDashboard = lazy(() => import("./pages/SystemDashboard").then((m) => ({ default: m.SystemDashboard })));
const SystemHealth = lazy(() => import("./pages/SystemHealth").then((m) => ({ default: m.SystemHealth })));
const SalesTeam = lazy(() => import("./pages/SalesTeam").then((m) => ({ default: m.SalesTeam })));
const SalesTeamDetail = lazy(() => import("./pages/SalesTeamDetail").then((m) => ({ default: m.SalesTeamDetail })));
const SalesTeamMaintenance = lazy(() => import("./pages/SalesTeamMaintenance").then((m) => ({ default: m.SalesTeamMaintenance })));
const Gamification = lazy(() => import("./pages/Gamification").then((m) => ({ default: m.Gamification })));
const GamificationAdmin = lazy(() => import("./pages/GamificationAdmin").then((m) => ({ default: m.GamificationAdmin })));
const Shop = lazy(() => import("./pages/Shop").then((m) => ({ default: m.Shop })));
const Innovations = lazy(() => import("./pages/Innovations").then((m) => ({ default: m.Innovations })));
const Suggestions = lazy(() => import("./pages/Suggestions").then((m) => ({ default: m.Suggestions })));
const IdeaDetail = lazy(() => import("./pages/IdeaDetail").then((m) => ({ default: m.IdeaDetail })));
const PettyCash = lazy(() => import("./pages/PettyCash").then((m) => ({ default: m.PettyCash })));
const Logistics = lazy(() => import("./pages/Logistics").then((m) => ({ default: m.Logistics })));
const TripDetail = lazy(() => import("./pages/TripDetail").then((m) => ({ default: m.TripDetail })));
const StaffDetail = lazy(() => import("./pages/StaffDetail").then((m) => ({ default: m.StaffDetail })));
const LorryDetail = lazy(() => import("./pages/LorryDetail").then((m) => ({ default: m.LorryDetail })));
const DeliveryDetail = lazy(() => import("./pages/DeliveryTracking").then((m) => ({ default: m.DeliveryDetail })));
const DriverHome = lazy(() => import("./pages/DriverHome").then((m) => ({ default: m.DriverHome })));
const DriverTrip = lazy(() => import("./pages/DriverTrip").then((m) => ({ default: m.DriverTrip })));
const DriverProfile = lazy(() => import("./pages/DriverProfile").then((m) => ({ default: m.DriverProfile })));
const DriverProjects = lazy(() => import("./pages/DriverProjects").then((m) => ({ default: m.DriverProjects })));
const DriverProjectDetail = lazy(() => import("./pages/DriverProjectDetail").then((m) => ({ default: m.DriverProjectDetail })));

/**
 * Wraps a route element in a permission check. Failures render the
 * <Forbidden> page inline (URL preserved) so the user understands why
 * they were blocked — see frontend/src/pages/Forbidden.tsx. Old
 * behaviour was a silent redirect to "/", which left people
 * confused.
 */
function Guard({
  perm,
  anyPerm,
  children,
}: {
  perm?: string;
  anyPerm?: string[];
  children: React.ReactNode;
}) {
  const { can } = useAuth();
  if (perm && !can(perm)) return <Forbidden page={perm} />;
  if (anyPerm && !anyPerm.some((p) => can(p)))
    return <Forbidden page={anyPerm.join(" / ")} />;
  return <>{children}</>;
}

/**
 * Navigate that carries the current ?query= string through, plus any
 * extra params the caller wants to add. Used for the /trips → /logistics
 * redirect so `?focus=…` deep links (from inbox, search, cron emails)
 * keep working.
 */
function RedirectKeepQuery({
  to,
  extraParams,
}: {
  to: string;
  extraParams?: Record<string, string>;
}) {
  const loc = useLocation();
  const search = new URLSearchParams(loc.search);
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) search.set(k, v);
  }
  const qs = search.toString();
  const next: To = { pathname: to, search: qs ? `?${qs}` : "" };
  return <Navigate to={next} replace />;
}

/**
 * Driver-only users (have trips.read.own but no trips.read.all and no
 * other operational permissions) get auto-routed to the mobile driver
 * shell when they hit "/". Dispatchers and admins land on Overview as
 * before.
 *
 * Detection rule: if the user can read trips but only their own, and
 * they cannot read sales orders, treat them as a driver. This avoids
 * trapping owners with the wildcard permission.
 */
function isDriverOnly(can: (p: string) => boolean): boolean {
  if (can("*")) return false;
  if (can("trips.read.all")) return false;
  if (!can("trips.read.own")) return false;
  // If they can't see any of the office tabs, they're driver-only.
  return !can("sales_orders.read") && !can("delivery_orders.read");
}

export default function App() {
  const { can } = useAuth();
  const location = useLocation();
  const driverOnly = isDriverOnly(can);

  // Bounce driver-only users into /driver when they land anywhere else.
  if (driverOnly && !location.pathname.startsWith("/driver")) {
    return <Navigate to="/driver" replace />;
  }

  // Mobile driver shell — distinct from the dispatcher Layout.
  if (location.pathname.startsWith("/driver")) {
    return (
      <DriverLayout>
        <ChunkReloadBoundary>
        <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/driver" element={<DriverHome />} />
          <Route path="/driver/me" element={<DriverProfile />} />
          <Route path="/driver/trips/:id" element={<DriverTrip />} />
          <Route path="/driver/projects" element={<DriverProjects />} />
          <Route path="/driver/projects/:id" element={<DriverProjectDetail />} />
          <Route path="*" element={<Navigate to="/driver" replace />} />
        </Routes>
        </Suspense>
        </ChunkReloadBoundary>
      </DriverLayout>
    );
  }

  return (
    <GlobalSearchProvider>
      <NotificationsProvider>
      <BreadcrumbsProvider>
      <BrowserPushSink />
      <QuickActionsFAB />
      <Layout>
        <ChunkReloadBoundary>
        <Suspense fallback={<PageSkeleton />}>
        <Routes>
        <Route path="/" element={<Overview />} />
        <Route
          path="/orders"
          element={
            <PageGuard page="orders">
              <Orders />
            </PageGuard>
          }
        />
        <Route
          path="/orders/items"
          element={
            <PageGuard page="orders">
              <SalesOrderItems />
            </PageGuard>
          }
        />
        <Route
          path="/orders/:docNo"
          element={
            <PageGuard page="orders">
              <OrderDetail />
            </PageGuard>
          }
        />
        <Route
          path="/delivery-orders"
          element={
            <PageGuard page="delivery_orders">
              <DeliveryOrders />
            </PageGuard>
          }
        />
        <Route
          path="/logistics"
          element={
            <PageGuard page="logistics">
              <Logistics />
            </PageGuard>
          }
        />
        <Route
          path="/trips/:id"
          element={
            <PageGuard page="logistics">
              <TripDetail />
            </PageGuard>
          }
        />
        <Route
          path="/staff/:id"
          element={
            <PageGuard page="logistics.fleet">
              <StaffDetail />
            </PageGuard>
          }
        />
        <Route
          path="/lorries/:id"
          element={
            <PageGuard page="logistics.fleet">
              <LorryDetail />
            </PageGuard>
          }
        />
        <Route
          path="/delivery/:docNo"
          element={
            <PageGuard page="delivery_orders">
              <DeliveryDetail />
            </PageGuard>
          }
        />
        {/* Legacy deep-links — preserve query string (?focus=…) */}
        <Route
          path="/trips"
          element={<RedirectKeepQuery to="/logistics" extraParams={{ tab: "trips" }} />}
        />
        <Route
          path="/fleet"
          element={<RedirectKeepQuery to="/logistics" extraParams={{ tab: "fleet" }} />}
        />
        <Route
          path="/po"
          element={
            <PageGuard page="purchase_orders">
              <PurchaseOrders />
            </PageGuard>
          }
        />
        <Route
          path="/po/:docNo"
          element={
            <PageGuard page="purchase_orders">
              <PurchaseOrderDetail />
            </PageGuard>
          }
        />
        {/* Legacy /creditors → Purchase Orders' Creditors tab */}
        <Route
          path="/creditors"
          element={<Navigate to="/po?view=creditors" replace />}
        />
        <Route
          path="/creditors/:code"
          element={
            <PageGuard page="purchase_orders">
              <CreditorDetail />
            </PageGuard>
          }
        />
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
        {/* Supply Chain — Suppliers (1:1 clone of 2990s). Owner-only for
            now (matches the backend requirePermission("*") gate). */}
        <Route
          path="/suppliers"
          element={
            <Guard perm="*">
              <Suppliers />
            </Guard>
          }
        />
        <Route
          path="/suppliers/:id"
          element={
            <Guard perm="*">
              <SupplierDetail />
            </Guard>
          }
        />
        {/* Supply Chain — Purchase Orders (1:1 clone of 2990s, pages/scm/*).
            Owner-only (perm "*"), matching the backend requirePermission("*")
            gate. DISTINCT from the AutoCount /po route/page. Static paths
            (/new, /from-so) MUST precede the /:id param route. */}
        <Route
          path="/purchase-orders"
          element={
            <Guard perm="*">
              <ScmPurchaseOrders />
            </Guard>
          }
        />
        <Route
          path="/purchase-orders/new"
          element={
            <Guard perm="*">
              <ScmPurchaseOrderNew />
            </Guard>
          }
        />
        <Route
          path="/purchase-orders/from-so"
          element={
            <Guard perm="*">
              <ScmPurchaseOrderFromSo />
            </Guard>
          }
        />
        <Route
          path="/purchase-orders/:id"
          element={
            <Guard perm="*">
              <ScmPurchaseOrderDetail />
            </Guard>
          }
        />
        {/* Supply Chain — Inventory + Warehouse (1:1 clone of 2990s, pages/scm/*).
            Owner-only (perm "*"), matching the backend requirePermission("*")
            gate. /api/inventory + /api/mfg-warehouses back these. Static
            /stock-adjustments/new precedes the /stock-card/:productCode param. */}
        <Route
          path="/inventory"
          element={
            <Guard perm="*">
              <ScmInventory />
            </Guard>
          }
        />
        <Route
          path="/stock-card/:productCode"
          element={
            <Guard perm="*">
              <ScmStockCard />
            </Guard>
          }
        />
        <Route
          path="/stock-adjustments/new"
          element={
            <Guard perm="*">
              <ScmStockAdjustmentNew />
            </Guard>
          }
        />
        <Route
          path="/stock-adjustments"
          element={
            <Guard perm="*">
              <ScmStockAdjustments />
            </Guard>
          }
        />
        <Route
          path="/warehouses"
          element={
            <Guard perm="*">
              <ScmWarehouses />
            </Guard>
          }
        />
        {/* Supply Chain — Goods Receipt (GRN) (1:1 clone of 2990s, pages/scm/*).
            Owner-only (perm "*"), matching the backend requirePermission("*")
            gate. /api/grns backs these. Static /new + /from-po MUST precede the
            /:id param route. */}
        <Route
          path="/grns"
          element={
            <Guard perm="*">
              <ScmGoodsReceived />
            </Guard>
          }
        />
        <Route
          path="/grns/new"
          element={
            <Guard perm="*">
              <ScmGrnNew />
            </Guard>
          }
        />
        <Route
          path="/grns/from-po"
          element={
            <Guard perm="*">
              <ScmGrnFromPo />
            </Guard>
          }
        />
        <Route
          path="/grns/:id"
          element={
            <Guard perm="*">
              <ScmGoodsReceivedDetail />
            </Guard>
          }
        />
        {/* Supply Chain — Purchase Invoice (AP) + Purchase Return (stock OUT)
            (1:1 clone of 2990s, pages/scm/*). Owner-only (perm "*"), matching the
            backend requirePermission("*") gate. /api/purchase-invoices +
            /api/purchase-returns back these. Static /new + /from-grn MUST precede
            the /:id param route. */}
        <Route
          path="/purchase-invoices"
          element={
            <Guard perm="*">
              <ScmPurchaseInvoices />
            </Guard>
          }
        />
        <Route
          path="/purchase-invoices/new"
          element={
            <Guard perm="*">
              <ScmPurchaseInvoiceNew />
            </Guard>
          }
        />
        <Route
          path="/purchase-invoices/from-grn"
          element={
            <Guard perm="*">
              <ScmPurchaseInvoiceFromGrn />
            </Guard>
          }
        />
        <Route
          path="/purchase-invoices/:id"
          element={
            <Guard perm="*">
              <ScmPurchaseInvoiceDetail />
            </Guard>
          }
        />
        <Route
          path="/purchase-returns"
          element={
            <Guard perm="*">
              <ScmPurchaseReturns />
            </Guard>
          }
        />
        <Route
          path="/purchase-returns/new"
          element={
            <Guard perm="*">
              <ScmPurchaseReturnNew />
            </Guard>
          }
        />
        <Route
          path="/purchase-returns/:id"
          element={
            <Guard perm="*">
              <ScmPurchaseReturnDetail />
            </Guard>
          }
        />
        {/* Supply Chain — Stock Transfers + Stock Takes (1:1 clone of 2990s,
            pages/scm/*). Owner-only (perm "*"), matching the backend
            requirePermission("*") gate. /api/stock-transfers + /api/stock-takes
            back these. Static /new MUST precede the /:id param route. */}
        <Route
          path="/stock-transfers"
          element={
            <Guard perm="*">
              <ScmStockTransfers />
            </Guard>
          }
        />
        <Route
          path="/stock-transfers/new"
          element={
            <Guard perm="*">
              <ScmStockTransferNew />
            </Guard>
          }
        />
        <Route
          path="/stock-transfers/:id"
          element={
            <Guard perm="*">
              <ScmStockTransferDetail />
            </Guard>
          }
        />
        <Route
          path="/stock-takes"
          element={
            <Guard perm="*">
              <ScmStockTakes />
            </Guard>
          }
        />
        <Route
          path="/stock-takes/new"
          element={
            <Guard perm="*">
              <ScmStockTakeNew />
            </Guard>
          }
        />
        <Route
          path="/stock-takes/:id"
          element={
            <Guard perm="*">
              <ScmStockTakeDetail />
            </Guard>
          }
        />
        {/* Supply Chain — Sales Orders (1:1 clone of 2990s, pages/scm/*). Owner-
            only (perm "*"), matching the backend requirePermission("*") gate.
            /api/mfg-sales-orders backs these. DISTINCT from the AutoCount /orders
            + /sales routes. Static /new MUST precede the /:docNo param route. */}
        <Route
          path="/sales-orders"
          element={
            <Guard perm="*">
              <ScmSalesOrders />
            </Guard>
          }
        />
        <Route
          path="/sales-orders/new"
          element={
            <Guard perm="*">
              <ScmSalesOrderNew />
            </Guard>
          }
        />
        <Route
          path="/sales-orders/:docNo"
          element={
            <Guard perm="*">
              <ScmSalesOrderDetail />
            </Guard>
          }
        />
        {/* Supply Chain — Delivery Orders + Sales Invoices + Delivery Returns
            (order-to-cash downstream, 1:1 clone of 2990s, pages/scm/*). Owner-only
            (perm "*"). /api/mfg-delivery-orders + /api/sales-invoices +
            /api/delivery-returns back these. DISTINCT from the AutoCount
            DeliveryOrders page. Static /from-so + /from-do MUST precede /:id. */}
        <Route path="/delivery-orders" element={<Guard perm="*"><ScmDeliveryOrders /></Guard>} />
        <Route path="/delivery-orders/from-so" element={<Guard perm="*"><ScmDeliveryOrderFromSo /></Guard>} />
        <Route path="/delivery-orders/:id" element={<Guard perm="*"><ScmDeliveryOrderDetail /></Guard>} />
        <Route path="/sales-invoices" element={<Guard perm="*"><ScmSalesInvoices /></Guard>} />
        <Route path="/sales-invoices/from-do" element={<Guard perm="*"><ScmSalesInvoiceFromDo /></Guard>} />
        <Route path="/sales-invoices/:id" element={<Guard perm="*"><ScmSalesInvoiceDetail /></Guard>} />
        <Route path="/delivery-returns" element={<Guard perm="*"><ScmDeliveryReturns /></Guard>} />
        <Route path="/delivery-returns/from-do" element={<Guard perm="*"><ScmDeliveryReturnFromDo /></Guard>} />
        <Route path="/delivery-returns/:id" element={<Guard perm="*"><ScmDeliveryReturnDetail /></Guard>} />
        {/* Supply Chain — CONSIGNMENT (PURCHASE side, 1:1 clone of 2990s,
            pages/scm/*). Owner-only (perm "*"). /api/purchase-consignment-orders|
            receives|returns back these. Static /new + /from-* MUST precede /:id. */}
        <Route path="/purchase-consignment-orders" element={<Guard perm="*"><ScmPcOrders /></Guard>} />
        <Route path="/purchase-consignment-orders/new" element={<Guard perm="*"><ScmPcOrderNew /></Guard>} />
        <Route path="/purchase-consignment-orders/:id" element={<Guard perm="*"><ScmPcOrderDetail /></Guard>} />
        <Route path="/purchase-consignment-receives" element={<Guard perm="*"><ScmPcReceives /></Guard>} />
        <Route path="/purchase-consignment-receives/from-order" element={<Guard perm="*"><ScmPcReceiveFromOrder /></Guard>} />
        <Route path="/purchase-consignment-receives/new" element={<Guard perm="*"><ScmPcReceiveNew /></Guard>} />
        <Route path="/purchase-consignment-receives/:id" element={<Guard perm="*"><ScmPcReceiveDetail /></Guard>} />
        <Route path="/purchase-consignment-returns" element={<Guard perm="*"><ScmPcReturns /></Guard>} />
        <Route path="/purchase-consignment-returns/from-receive" element={<Guard perm="*"><ScmPcReturnFromReceive /></Guard>} />
        <Route path="/purchase-consignment-returns/new" element={<Guard perm="*"><ScmPcReturnNew /></Guard>} />
        <Route path="/purchase-consignment-returns/:id" element={<Guard perm="*"><ScmPcReturnDetail /></Guard>} />
        {/* SCM 1:1 clone — CONSIGNMENT (sales side, #67 part 2, pages/scm/*). Owner-
            only (perm "*"). /api/consignment-orders|notes|returns back these. Static
            /new + /from-* before /:id|/:docNo. */}
        <Route path="/consignment-orders" element={<Guard perm="*"><ScmCoOrders /></Guard>} />
        <Route path="/consignment-orders/new" element={<Guard perm="*"><ScmCoOrderNew /></Guard>} />
        <Route path="/consignment-orders/:docNo" element={<Guard perm="*"><ScmCoOrderDetail /></Guard>} />
        <Route path="/consignment-notes" element={<Guard perm="*"><ScmCnNotes /></Guard>} />
        <Route path="/consignment-notes/from-order" element={<Guard perm="*"><ScmCnNoteFromOrder /></Guard>} />
        <Route path="/consignment-notes/new" element={<Guard perm="*"><ScmCnNoteNew /></Guard>} />
        <Route path="/consignment-notes/:id" element={<Guard perm="*"><ScmCnNoteDetail /></Guard>} />
        <Route path="/consignment-returns" element={<Guard perm="*"><ScmCrReturns /></Guard>} />
        <Route path="/consignment-returns/from-note" element={<Guard perm="*"><ScmCrReturnFromNote /></Guard>} />
        <Route path="/consignment-returns/new" element={<Guard perm="*"><ScmCrReturnNew /></Guard>} />
        <Route path="/consignment-returns/:id" element={<Guard perm="*"><ScmCrReturnDetail /></Guard>} />
        <Route
          path="/sales"
          element={
            <PageGuard page="sales">
              <Sales />
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
          path="/system"
          element={
            <PageGuard page="team">
              <SystemDashboard />
            </PageGuard>
          }
        />
        <Route
          path="/system-health"
          element={
            <Guard perm="*">
              <SystemHealth />
            </Guard>
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
        <Route
          path="/sales-team"
          element={
            <PageGuard page="sales_team">
              <SalesTeam />
            </PageGuard>
          }
        />
        <Route
          path="/sales-team/:id"
          element={
            <PageGuard page="sales_team">
              <SalesTeamDetail />
            </PageGuard>
          }
        />
        <Route
          path="/sales-team-maintenance"
          element={
            <PageGuard page="sales_team_maintenance" minLevel="full">
              <SalesTeamMaintenance />
            </PageGuard>
          }
        />
        {/* Legacy /roles → Team page's Roles tab */}
        <Route
          path="/roles"
          element={<Navigate to="/team?tab=roles" replace />}
        />
        <Route
          path="/notifications"
          element={
            <Guard perm="projects.read">
              <Notifications />
            </Guard>
          }
        />
        <Route path="/gamification" element={<Gamification />} />
        <Route path="/gamification/admin" element={<GamificationAdmin />} />
        <Route path="/shop" element={<Shop />} />
        <Route path="/petty-cash" element={<PettyCash />} />
        <Route path="/innovations" element={<Innovations />} />
        <Route path="/innovations/:id" element={<IdeaDetail target="innovation" />} />
        <Route path="/suggestions" element={<Suggestions />} />
        <Route path="/suggestions/:id" element={<IdeaDetail target="suggestion" />} />
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
