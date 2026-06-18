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
        <Route path="/scm/purchase-orders/:id" element={<Guard perm="*"><ScmPurchaseOrderDetail /></Guard>} />
        <Route path="/scm/grns" element={<Guard perm="*"><ScmGoodsReceived /></Guard>} />
        <Route path="/scm/grns/:id" element={<Guard perm="*"><ScmGoodsReceivedDetail /></Guard>} />
        <Route path="/scm/purchase-invoices" element={<Guard perm="*"><ScmPurchaseInvoices /></Guard>} />
        <Route path="/scm/purchase-invoices/:id" element={<Guard perm="*"><ScmPurchaseInvoiceDetail /></Guard>} />
        <Route path="/scm/purchase-returns" element={<Guard perm="*"><ScmPurchaseReturns /></Guard>} />
        <Route path="/scm/purchase-returns/:id" element={<Guard perm="*"><ScmPurchaseReturnDetail /></Guard>} />
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
