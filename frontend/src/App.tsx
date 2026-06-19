import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
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
// without touching the page files. Multi-page modules (ServiceCases, Projects)
// share one chunk.
const ServiceCases = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCases })));
const ServiceCaseDetail = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCaseDetail })));
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const ProjectDetail = lazy(() => import("./pages/Projects").then((m) => ({ default: m.ProjectDetail })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Team = lazy(() => import("./pages/Team").then((m) => ({ default: m.Team })));
const SystemHealth = lazy(() => import("./pages/SystemHealth").then((m) => ({ default: m.SystemHealth })));
// Ported 2990's SCM (furniture supply chain) — owner-gated under /scm/*.
const ScmSuppliers = lazy(() => import("./pages/scm/Suppliers").then((m) => ({ default: m.ScmSuppliers })));
const ScmSupplierDetail = lazy(() => import("./pages/scm/SupplierDetail").then((m) => ({ default: m.ScmSupplierDetail })));
const ScmPurchaseOrders = lazy(() => import("./pages/scm/PurchaseOrders").then((m) => ({ default: m.ScmPurchaseOrders })));
const ScmPurchaseOrderDetail = lazy(() => import("./pages/scm/PurchaseOrderDetail").then((m) => ({ default: m.ScmPurchaseOrderDetail })));
const ScmGoodsReceived = lazy(() => import("./pages/scm/GoodsReceived").then((m) => ({ default: m.ScmGoodsReceived })));
const ScmGoodsReceivedDetail = lazy(() => import("./pages/scm/GoodsReceivedDetail").then((m) => ({ default: m.ScmGoodsReceivedDetail })));
const ScmPurchaseInvoices = lazy(() => import("./pages/scm/PurchaseInvoices").then((m) => ({ default: m.ScmPurchaseInvoices })));
const ScmPurchaseInvoiceDetail = lazy(() => import("./pages/scm/PurchaseInvoiceDetail").then((m) => ({ default: m.ScmPurchaseInvoiceDetail })));
const ScmPurchaseReturns = lazy(() => import("./pages/scm/PurchaseReturns").then((m) => ({ default: m.ScmPurchaseReturns })));
const ScmPurchaseReturnDetail = lazy(() => import("./pages/scm/PurchaseReturnDetail").then((m) => ({ default: m.ScmPurchaseReturnDetail })));
const ScmPurchaseOrderNew = lazy(() => import("./pages/scm/PurchaseOrderNew").then((m) => ({ default: m.ScmPurchaseOrderNew })));
const ScmPurchaseInvoiceNew = lazy(() => import("./pages/scm/PurchaseInvoiceNew").then((m) => ({ default: m.ScmPurchaseInvoiceNew })));
const ScmPurchaseReturnNew = lazy(() => import("./pages/scm/PurchaseReturnNew").then((m) => ({ default: m.ScmPurchaseReturnNew })));
const ScmStockTransferNew = lazy(() => import("./pages/scm/StockTransferNew").then((m) => ({ default: m.ScmStockTransferNew })));
const ScmStockTakeNew = lazy(() => import("./pages/scm/StockTakeNew").then((m) => ({ default: m.ScmStockTakeNew })));
const ScmDeliveryOrderNew = lazy(() => import("./pages/scm/DeliveryOrderNew").then((m) => ({ default: m.ScmDeliveryOrderNew })));
const ScmDeliveryReturnNew = lazy(() => import("./pages/scm/DeliveryReturnNew").then((m) => ({ default: m.ScmDeliveryReturnNew })));
const ScmConsignmentOrderNew = lazy(() => import("./pages/scm/ConsignmentOrderNew").then((m) => ({ default: m.ScmConsignmentOrderNew })));
const ScmConsignmentNoteNew = lazy(() => import("./pages/scm/ConsignmentNoteNew").then((m) => ({ default: m.ScmConsignmentNoteNew })));
const ScmConsignmentReturnNew = lazy(() => import("./pages/scm/ConsignmentReturnNew").then((m) => ({ default: m.ScmConsignmentReturnNew })));
const ScmPurchaseConsignmentOrderNew = lazy(() => import("./pages/scm/PurchaseConsignmentOrderNew").then((m) => ({ default: m.ScmPurchaseConsignmentOrderNew })));
const ScmPurchaseConsignmentReceiveNew = lazy(() => import("./pages/scm/PurchaseConsignmentReceiveNew").then((m) => ({ default: m.ScmPurchaseConsignmentReceiveNew })));
const ScmPurchaseConsignmentReturnNew = lazy(() => import("./pages/scm/PurchaseConsignmentReturnNew").then((m) => ({ default: m.ScmPurchaseConsignmentReturnNew })));
const ScmInventory = lazy(() => import("./pages/scm/Inventory").then((m) => ({ default: m.ScmInventory })));
const ScmWarehouses = lazy(() => import("./pages/scm/Warehouses").then((m) => ({ default: m.ScmWarehouses })));
const ScmStockTransfers = lazy(() => import("./pages/scm/StockTransfers").then((m) => ({ default: m.ScmStockTransfers })));
const ScmStockTransferDetail = lazy(() => import("./pages/scm/StockTransferDetail").then((m) => ({ default: m.ScmStockTransferDetail })));
const ScmStockTakes = lazy(() => import("./pages/scm/StockTakes").then((m) => ({ default: m.ScmStockTakes })));
const ScmStockTakeDetail = lazy(() => import("./pages/scm/StockTakeDetail").then((m) => ({ default: m.ScmStockTakeDetail })));
const ScmMfgSalesOrders = lazy(() => import("./pages/scm/MfgSalesOrders").then((m) => ({ default: m.ScmMfgSalesOrders })));
const ScmMfgSalesOrderDetail = lazy(() => import("./pages/scm/MfgSalesOrderDetail").then((m) => ({ default: m.ScmMfgSalesOrderDetail })));
const ScmMfgSalesOrderNew = lazy(() => import("./pages/scm/MfgSalesOrderNew").then((m) => ({ default: m.ScmMfgSalesOrderNew })));
const ScmMaintenanceConfig = lazy(() => import("./pages/scm/MaintenanceConfig").then((m) => ({ default: m.ScmMaintenanceConfig })));
const ScmDeliveryOrders = lazy(() => import("./pages/scm/DeliveryOrders").then((m) => ({ default: m.ScmDeliveryOrders })));
const ScmDeliveryOrderDetail = lazy(() => import("./pages/scm/DeliveryOrderDetail").then((m) => ({ default: m.ScmDeliveryOrderDetail })));
const ScmDeliveryReturns = lazy(() => import("./pages/scm/DeliveryReturns").then((m) => ({ default: m.ScmDeliveryReturns })));
const ScmDeliveryReturnDetail = lazy(() => import("./pages/scm/DeliveryReturnDetail").then((m) => ({ default: m.ScmDeliveryReturnDetail })));
const ScmProducts = lazy(() => import("./pages/scm/Products").then((m) => ({ default: m.ScmProducts })));
const ScmProductModels = lazy(() => import("./pages/scm/ProductModels").then((m) => ({ default: m.ScmProductModels })));
const ScmProductModelDetail = lazy(() => import("./pages/scm/ProductModelDetail").then((m) => ({ default: m.ScmProductModelDetail })));
const ScmMrp = lazy(() => import("./pages/scm/Mrp").then((m) => ({ default: m.ScmMrp })));
const ScmMrpLeadTimes = lazy(() => import("./pages/scm/MrpLeadTimes").then((m) => ({ default: m.ScmMrpLeadTimes })));
const ScmFabricTracking = lazy(() => import("./pages/scm/FabricTracking").then((m) => ({ default: m.ScmFabricTracking })));
const ScmAccounting = lazy(() => import("./pages/scm/Accounting").then((m) => ({ default: m.ScmAccounting })));
const ScmOutstanding = lazy(() => import("./pages/scm/Outstanding").then((m) => ({ default: m.ScmOutstanding })));
const ScmConsignmentOrders = lazy(() => import("./pages/scm/ConsignmentOrders").then((m) => ({ default: m.ScmConsignmentOrders })));
const ScmConsignmentOrderDetail = lazy(() => import("./pages/scm/ConsignmentOrderDetail").then((m) => ({ default: m.ScmConsignmentOrderDetail })));
const ScmConsignmentNotes = lazy(() => import("./pages/scm/ConsignmentNotes").then((m) => ({ default: m.ScmConsignmentNotes })));
const ScmConsignmentNoteDetail = lazy(() => import("./pages/scm/ConsignmentNoteDetail").then((m) => ({ default: m.ScmConsignmentNoteDetail })));
const ScmConsignmentReturns = lazy(() => import("./pages/scm/ConsignmentReturns").then((m) => ({ default: m.ScmConsignmentReturns })));
const ScmConsignmentReturnDetail = lazy(() => import("./pages/scm/ConsignmentReturnDetail").then((m) => ({ default: m.ScmConsignmentReturnDetail })));
const ScmPurchaseConsignmentOrders = lazy(() => import("./pages/scm/PurchaseConsignmentOrders").then((m) => ({ default: m.ScmPurchaseConsignmentOrders })));
const ScmPurchaseConsignmentOrderDetail = lazy(() => import("./pages/scm/PurchaseConsignmentOrderDetail").then((m) => ({ default: m.ScmPurchaseConsignmentOrderDetail })));
const ScmPurchaseConsignmentReceives = lazy(() => import("./pages/scm/PurchaseConsignmentReceives").then((m) => ({ default: m.ScmPurchaseConsignmentReceives })));
const ScmPurchaseConsignmentReceiveDetail = lazy(() => import("./pages/scm/PurchaseConsignmentReceiveDetail").then((m) => ({ default: m.ScmPurchaseConsignmentReceiveDetail })));
const ScmPurchaseConsignmentReturns = lazy(() => import("./pages/scm/PurchaseConsignmentReturns").then((m) => ({ default: m.ScmPurchaseConsignmentReturns })));
const ScmPurchaseConsignmentReturnDetail = lazy(() => import("./pages/scm/PurchaseConsignmentReturnDetail").then((m) => ({ default: m.ScmPurchaseConsignmentReturnDetail })));

/**
 * Wraps a route element in a permission check. Failures render the
 * <Forbidden> page inline (URL preserved) so the user understands why
 * they were blocked — see frontend/src/pages/Forbidden.tsx.
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

export default function App() {
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
        {/* Landing → Service (QMS). No standalone Overview after the cutover. */}
        <Route path="/" element={<Navigate to="/assr" replace />} />
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
        {/* ── Supply Chain (ported 2990's SCM) — owner-gated /scm/* ── */}
        <Route
          path="/scm/suppliers"
          element={
            <Guard perm="*">
              <ScmSuppliers />
            </Guard>
          }
        />
        <Route
          path="/scm/suppliers/:id"
          element={
            <Guard perm="*">
              <ScmSupplierDetail />
            </Guard>
          }
        />
        <Route path="/scm/purchase-orders" element={<Guard perm="*"><ScmPurchaseOrders /></Guard>} />
        <Route path="/scm/purchase-orders/new" element={<Guard perm="*"><ScmPurchaseOrderNew /></Guard>} />
        <Route path="/scm/purchase-orders/:id" element={<Guard perm="*"><ScmPurchaseOrderDetail /></Guard>} />
        <Route path="/scm/grns" element={<Guard perm="*"><ScmGoodsReceived /></Guard>} />
        <Route path="/scm/grns/:id" element={<Guard perm="*"><ScmGoodsReceivedDetail /></Guard>} />
        <Route path="/scm/purchase-invoices" element={<Guard perm="*"><ScmPurchaseInvoices /></Guard>} />
        <Route path="/scm/purchase-invoices/new" element={<Guard perm="*"><ScmPurchaseInvoiceNew /></Guard>} />
        <Route path="/scm/purchase-invoices/:id" element={<Guard perm="*"><ScmPurchaseInvoiceDetail /></Guard>} />
        <Route path="/scm/purchase-returns" element={<Guard perm="*"><ScmPurchaseReturns /></Guard>} />
        <Route path="/scm/purchase-returns/new" element={<Guard perm="*"><ScmPurchaseReturnNew /></Guard>} />
        <Route path="/scm/purchase-returns/:id" element={<Guard perm="*"><ScmPurchaseReturnDetail /></Guard>} />
        <Route path="/scm/inventory" element={<Guard perm="*"><ScmInventory /></Guard>} />
        <Route path="/scm/warehouses" element={<Guard perm="*"><ScmWarehouses /></Guard>} />
        <Route path="/scm/stock-transfers" element={<Guard perm="*"><ScmStockTransfers /></Guard>} />
        <Route path="/scm/stock-transfers/new" element={<Guard perm="*"><ScmStockTransferNew /></Guard>} />
        <Route path="/scm/stock-transfers/:id" element={<Guard perm="*"><ScmStockTransferDetail /></Guard>} />
        <Route path="/scm/stock-takes" element={<Guard perm="*"><ScmStockTakes /></Guard>} />
        <Route path="/scm/stock-takes/new" element={<Guard perm="*"><ScmStockTakeNew /></Guard>} />
        <Route path="/scm/stock-takes/:id" element={<Guard perm="*"><ScmStockTakeDetail /></Guard>} />
        <Route path="/scm/sales-orders" element={<Guard perm="*"><ScmMfgSalesOrders /></Guard>} />
        <Route path="/scm/sales-orders/new" element={<Guard perm="*"><ScmMfgSalesOrderNew /></Guard>} />
        <Route path="/scm/sales-orders/:id" element={<Guard perm="*"><ScmMfgSalesOrderDetail /></Guard>} />
        <Route path="/scm/delivery-orders" element={<Guard perm="*"><ScmDeliveryOrders /></Guard>} />
        <Route path="/scm/delivery-orders/new" element={<Guard perm="*"><ScmDeliveryOrderNew /></Guard>} />
        <Route path="/scm/delivery-orders/:id" element={<Guard perm="*"><ScmDeliveryOrderDetail /></Guard>} />
        <Route path="/scm/delivery-returns" element={<Guard perm="*"><ScmDeliveryReturns /></Guard>} />
        <Route path="/scm/delivery-returns/new" element={<Guard perm="*"><ScmDeliveryReturnNew /></Guard>} />
        <Route path="/scm/delivery-returns/:id" element={<Guard perm="*"><ScmDeliveryReturnDetail /></Guard>} />
        <Route path="/scm/products" element={<Guard perm="*"><ScmProducts /></Guard>} />
        <Route path="/scm/product-models" element={<Guard perm="*"><ScmProductModels /></Guard>} />
        <Route path="/scm/product-models/:id" element={<Guard perm="*"><ScmProductModelDetail /></Guard>} />
        <Route path="/scm/mrp" element={<Guard perm="*"><ScmMrp /></Guard>} />
        <Route path="/scm/mrp-lead-times" element={<Guard perm="*"><ScmMrpLeadTimes /></Guard>} />
        <Route path="/scm/fabric-tracking" element={<Guard perm="*"><ScmFabricTracking /></Guard>} />
        <Route path="/scm/accounting" element={<Guard perm="*"><ScmAccounting /></Guard>} />
        <Route path="/scm/outstanding" element={<Guard perm="*"><ScmOutstanding /></Guard>} />
        <Route path="/scm/consignment-orders" element={<Guard perm="*"><ScmConsignmentOrders /></Guard>} />
        <Route path="/scm/consignment-orders/new" element={<Guard perm="*"><ScmConsignmentOrderNew /></Guard>} />
        <Route path="/scm/consignment-orders/:id" element={<Guard perm="*"><ScmConsignmentOrderDetail /></Guard>} />
        <Route path="/scm/consignment-notes" element={<Guard perm="*"><ScmConsignmentNotes /></Guard>} />
        <Route path="/scm/consignment-notes/new" element={<Guard perm="*"><ScmConsignmentNoteNew /></Guard>} />
        <Route path="/scm/consignment-notes/:id" element={<Guard perm="*"><ScmConsignmentNoteDetail /></Guard>} />
        <Route path="/scm/consignment-returns" element={<Guard perm="*"><ScmConsignmentReturns /></Guard>} />
        <Route path="/scm/consignment-returns/new" element={<Guard perm="*"><ScmConsignmentReturnNew /></Guard>} />
        <Route path="/scm/consignment-returns/:id" element={<Guard perm="*"><ScmConsignmentReturnDetail /></Guard>} />
        <Route path="/scm/purchase-consignment-orders" element={<Guard perm="*"><ScmPurchaseConsignmentOrders /></Guard>} />
        <Route path="/scm/purchase-consignment-orders/new" element={<Guard perm="*"><ScmPurchaseConsignmentOrderNew /></Guard>} />
        <Route path="/scm/purchase-consignment-orders/:id" element={<Guard perm="*"><ScmPurchaseConsignmentOrderDetail /></Guard>} />
        <Route path="/scm/purchase-consignment-receives" element={<Guard perm="*"><ScmPurchaseConsignmentReceives /></Guard>} />
        <Route path="/scm/purchase-consignment-receives/new" element={<Guard perm="*"><ScmPurchaseConsignmentReceiveNew /></Guard>} />
        <Route path="/scm/purchase-consignment-receives/:id" element={<Guard perm="*"><ScmPurchaseConsignmentReceiveDetail /></Guard>} />
        <Route path="/scm/purchase-consignment-returns" element={<Guard perm="*"><ScmPurchaseConsignmentReturns /></Guard>} />
        <Route path="/scm/purchase-consignment-returns/new" element={<Guard perm="*"><ScmPurchaseConsignmentReturnNew /></Guard>} />
        <Route path="/scm/purchase-consignment-returns/:id" element={<Guard perm="*"><ScmPurchaseConsignmentReturnDetail /></Guard>} />
        <Route path="/scm/maintenance" element={<Guard perm="*"><ScmMaintenanceConfig /></Guard>} />
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
