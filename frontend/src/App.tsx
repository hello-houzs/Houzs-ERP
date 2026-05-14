import { Routes, Route, Navigate, useLocation, type To } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DriverLayout } from "./components/DriverLayout";
import { Overview } from "./pages/Overview";
import { Orders } from "./pages/Orders";
import { OrderDetail } from "./pages/OrderDetail";
import { DeliveryOrders } from "./pages/DeliveryOrders";
import { PurchaseOrders, PurchaseOrderDetail } from "./pages/PurchaseOrders";
import { CreditorDetail } from "./pages/CreditorDetail";
import { ServiceCases, ServiceCaseDetail } from "./pages/ServiceCases";
import { Projects, ProjectDetail } from "./pages/Projects";
import { Sales } from "./pages/Sales";
import { Notifications } from "./pages/Notifications";
import { Profile } from "./pages/Profile";
import { Settings } from "./pages/Settings";
import { Team } from "./pages/Team";
import { SalesTeam } from "./pages/SalesTeam";
import { SalesTeamDetail } from "./pages/SalesTeamDetail";
import { SalesTeamMaintenance } from "./pages/SalesTeamMaintenance";
import { Gamification } from "./pages/Gamification";
import { GamificationAdmin } from "./pages/GamificationAdmin";
import { Shop } from "./pages/Shop";
import { Innovations } from "./pages/Innovations";
import { Suggestions } from "./pages/Suggestions";
import { IdeaDetail } from "./pages/IdeaDetail";
import { PettyCash } from "./pages/PettyCash";
import { Logistics } from "./pages/Logistics";
import { TripDetail } from "./pages/TripDetail";
import { StaffDetail } from "./pages/StaffDetail";
import { LorryDetail } from "./pages/LorryDetail";
import { DeliveryDetail } from "./pages/DeliveryTracking";
import { DriverHome } from "./pages/DriverHome";
import { DriverTrip } from "./pages/DriverTrip";
import { DriverProfile } from "./pages/DriverProfile";
import { useAuth } from "./auth/AuthContext";
import { PageGuard } from "./auth/PageGuard";
import { Forbidden } from "./pages/Forbidden";
import { GlobalSearchProvider } from "./components/GlobalSearch";
import { NotificationsProvider } from "./hooks/useNotifications";
import { BrowserPushSink } from "./components/BrowserPushSink";
import { QuickActionsFAB } from "./components/QuickActionsFAB";
import { BreadcrumbsProvider } from "./hooks/useBreadcrumbs";

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
        <Routes>
          <Route path="/driver" element={<DriverHome />} />
          <Route path="/driver/me" element={<DriverProfile />} />
          <Route path="/driver/trips/:id" element={<DriverTrip />} />
          <Route path="*" element={<Navigate to="/driver" replace />} />
        </Routes>
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
      </Layout>
      </BreadcrumbsProvider>
      </NotificationsProvider>
    </GlobalSearchProvider>
  );
}
