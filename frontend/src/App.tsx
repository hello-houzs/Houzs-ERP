import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DriverLayout } from "./components/DriverLayout";
import { Overview } from "./pages/Overview";
import { Orders } from "./pages/Orders";
import { DeliveryOrders } from "./pages/DeliveryOrders";
import { PurchaseOrders } from "./pages/PurchaseOrders";
import { ServiceCases } from "./pages/ServiceCases";
import { Balance } from "./pages/Balance";
import { Overdue } from "./pages/Overdue";
import { Logs } from "./pages/Logs";
import { Settings } from "./pages/Settings";
import { Team } from "./pages/Team";
import { Roles } from "./pages/Roles";
import { Trips } from "./pages/Trips";
import { Fleet } from "./pages/Fleet";
import { DriverHome } from "./pages/DriverHome";
import { DriverTrip } from "./pages/DriverTrip";
import { DriverProfile } from "./pages/DriverProfile";
import { useAuth } from "./auth/AuthContext";

/**
 * Wraps a route element in a permission check. Routes the user can't
 * access redirect home — the sidebar already hides them, but this is a
 * defense-in-depth in case someone navigates by URL.
 */
function Guard({ perm, children }: { perm: string; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(perm)) return <Navigate to="/" replace />;
  return <>{children}</>;
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
          path="/delivery-orders"
          element={
            <Guard perm="delivery_orders.read">
              <DeliveryOrders />
            </Guard>
          }
        />
        <Route
          path="/trips"
          element={
            <Guard perm="trips.read.all">
              <Trips />
            </Guard>
          }
        />
        <Route
          path="/fleet"
          element={
            <Guard perm="fleet.read">
              <Fleet />
            </Guard>
          }
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
          path="/assr"
          element={
            <Guard perm="service_cases.read">
              <ServiceCases />
            </Guard>
          }
        />
        <Route
          path="/balance"
          element={
            <Guard perm="balance.read">
              <Balance />
            </Guard>
          }
        />
        <Route
          path="/overdue"
          element={
            <Guard perm="overdue.read">
              <Overdue />
            </Guard>
          }
        />
        <Route
          path="/logs"
          element={
            <Guard perm="logs.read">
              <Logs />
            </Guard>
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
            <Guard perm="users.read">
              <Team />
            </Guard>
          }
        />
        <Route
          path="/roles"
          element={
            <Guard perm="roles.read">
              <Roles />
            </Guard>
          }
        />
      </Routes>
    </Layout>
  );
}
