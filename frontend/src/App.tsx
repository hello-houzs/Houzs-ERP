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
const ServiceCases = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCases })));
const ServiceCaseDetail = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCaseDetail })));
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const ProjectDetail = lazy(() => import("./pages/Projects").then((m) => ({ default: m.ProjectDetail })));
const Sales = lazy(() => import("./pages/Sales").then((m) => ({ default: m.Sales })));
const Notifications = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Team = lazy(() => import("./pages/Team").then((m) => ({ default: m.Team })));
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
            <Guard perm="sales_orders.read">
              <Orders />
            </Guard>
          }
        />
        <Route
          path="/orders/items"
          element={
            <Guard perm="sales_orders.read">
              <SalesOrderItems />
            </Guard>
          }
        />
        <Route
          path="/orders/:docNo"
          element={
            <Guard perm="sales_orders.read">
              <OrderDetail />
            </Guard>
          }
        />
        <Route
          path="/delivery-orders"
          element={
            <Guard perm="delivery_orders.read">
              <DeliveryOrders />
            </Guard>
          }
        />
        <Route
          path="/logistics"
          element={
            <Guard anyPerm={["trips.read.all", "fleet.read"]}>
              <Logistics />
            </Guard>
          }
        />
        <Route
          path="/trips/:id"
          element={
            <Guard anyPerm={["trips.read.all", "trips.read.own"]}>
              <TripDetail />
            </Guard>
          }
        />
        <Route
          path="/staff/:id"
          element={
            <Guard perm="fleet.read">
              <StaffDetail />
            </Guard>
          }
        />
        <Route
          path="/lorries/:id"
          element={
            <Guard perm="fleet.read">
              <LorryDetail />
            </Guard>
          }
        />
        <Route
          path="/delivery/:docNo"
          element={
            <Guard perm="delivery_orders.read">
              <DeliveryDetail />
            </Guard>
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
            <Guard perm="purchase_orders.read">
              <PurchaseOrders />
            </Guard>
          }
        />
        <Route
          path="/po/:docNo"
          element={
            <Guard perm="purchase_orders.read">
              <PurchaseOrderDetail />
            </Guard>
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
            <Guard perm="purchase_orders.read">
              <CreditorDetail />
            </Guard>
          }
        />
        <Route
          path="/assr"
          element={
            <Guard perm="service_cases.read">
              <ServiceCases />
            </Guard>
          }
        />
        <Route
          path="/assr/:id"
          element={
            <Guard perm="service_cases.read">
              <ServiceCaseDetail />
            </Guard>
          }
        />
        {/* Legacy /suppliers → Creditors tab under Purchase Orders.
            Phase 3 dropped the local Suppliers module; kept as redirect
            for existing bookmarks. */}
        <Route
          path="/suppliers"
          element={<Navigate to="/po?view=creditors" replace />}
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
            <Guard perm="settings.manage">
              <Settings />
            </Guard>
          }
        />
        <Route
          path="/team"
          element={
            <Guard anyPerm={["users.read", "roles.read"]}>
              <Team />
            </Guard>
          }
        />
        <Route
          path="/sales-team"
          element={
            <Guard perm="sales_team.read">
              <SalesTeam />
            </Guard>
          }
        />
        <Route
          path="/sales-team/:id"
          element={
            <Guard perm="sales_team.read">
              <SalesTeamDetail />
            </Guard>
          }
        />
        <Route
          path="/sales-team-maintenance"
          element={
            <Guard perm="sales_team.manage">
              <SalesTeamMaintenance />
            </Guard>
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
