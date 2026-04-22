import { Routes, Route } from 'react-router-dom';
import DashboardLayout from './layouts/DashboardLayout';
import PortalLayout from './layouts/PortalLayout';
import { AdminRoute } from './components/layout/admin-route';
import { ProtectedRoute } from './components/layout/protected-route';

// Auth pages
import LoginPage from './pages/LoginPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';

// Dashboard pages
import DashboardPage from './pages/DashboardPage';
import BdPage from './pages/BdPage';
import CalendarPage from './pages/CalendarPage';
import DriverPage from './pages/DriverPage';
import NewEventPage from './pages/NewEventPage';
import EventDetailPage from './pages/EventDetailPage';
import FinancePage from './pages/FinancePage';
import OperationPage from './pages/OperationPage';
import PmsPage from './pages/PmsPage';
import QmsPage from './pages/QmsPage';
import QmsDetailPage from './pages/QmsDetailPage';
import PrintCustomerPage from './pages/PrintCustomerPage';
import PrintSupplierPage from './pages/PrintSupplierPage';
import SalesPage from './pages/SalesPage';
import SODetailsPage from './pages/SODetailsPage';
import SalesOrderPage from './pages/SalesOrderPage';
import SKUCostingPage from './pages/SKUCostingPage';
import SettingsPage from './pages/SettingsPage';
import PortalPage from './pages/PortalPage';

// Admin pages
import AdminUsersPage from './pages/AdminUsersPage';
import AdminAuditLogPage from './pages/AdminAuditLogPage';
import AdminPermissionsPage from './pages/AdminPermissionsPage';

export default function App() {
  return (
    <Routes>
      {/* Public auth pages — no sidebar, no auth required */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Change-password is only reachable when authed (so we don't wrap
          it in the DashboardLayout because the user should see the full
          screen form + be forced here before any other route). */}
      <Route
        path="/change-password"
        element={
          <ProtectedRoute>
            <ChangePasswordPage />
          </ProtectedRoute>
        }
      />

      {/* Dashboard layout — all routes require auth */}
      <Route element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
        <Route path="/" element={<DashboardPage />} />
        {/* Admin-only: SALES */}
        <Route path="/sales" element={<AdminRoute><SalesPage /></AdminRoute>} />
        <Route path="/sales/details" element={<AdminRoute><SODetailsPage /></AdminRoute>} />
        <Route path="/sales/orders" element={<AdminRoute><SalesOrderPage /></AdminRoute>} />
        <Route path="/sales/sku-costing" element={<AdminRoute><SKUCostingPage /></AdminRoute>} />
        <Route path="/sales/sku/bedframe" element={<AdminRoute><SKUCostingPage category="BEDFRAME" /></AdminRoute>} />
        <Route path="/sales/sku/sofa" element={<AdminRoute><SKUCostingPage category="SOFA" /></AdminRoute>} />
        <Route path="/sales/sku/matt-acc" element={<AdminRoute><SKUCostingPage category="MATT_ACC" /></AdminRoute>} />
        <Route path="/sales/sku/others" element={<AdminRoute><SKUCostingPage category="OTHERS" /></AdminRoute>} />
        {/* Admin-only: QMS */}
        <Route path="/qms" element={<AdminRoute><QmsPage /></AdminRoute>} />
        <Route path="/qms/:id" element={<AdminRoute><QmsDetailPage /></AdminRoute>} />
        {/* Admin-only: DEPARTMENTS */}
        <Route path="/bd" element={<AdminRoute><BdPage /></AdminRoute>} />
        <Route path="/operation" element={<AdminRoute><OperationPage /></AdminRoute>} />
        <Route path="/driver" element={<AdminRoute><DriverPage /></AdminRoute>} />
        <Route path="/finance" element={<AdminRoute><FinancePage /></AdminRoute>} />
        {/* Shared: PROJECT MANAGEMENT module (all sales can access) */}
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/pms" element={<PmsPage />} />
        <Route path="/settings" element={<AdminRoute><SettingsPage /></AdminRoute>} />
        <Route path="/events/new" element={<AdminRoute><NewEventPage /></AdminRoute>} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        {/* Admin pages */}
        <Route path="/admin/users" element={<AdminRoute><AdminUsersPage /></AdminRoute>} />
        <Route path="/admin/audit-log" element={<AdminRoute><AdminAuditLogPage /></AdminRoute>} />
        <Route path="/admin/permissions" element={<AdminRoute><AdminPermissionsPage /></AdminRoute>} />
      </Route>

      {/* Print pages — auth required, no sidebar */}
      <Route path="/qms/:id/print-customer" element={<ProtectedRoute><PrintCustomerPage /></ProtectedRoute>} />
      <Route path="/qms/:id/print-supplier" element={<ProtectedRoute><PrintSupplierPage /></ProtectedRoute>} />

      {/* Portal — separate layout, auth still required */}
      <Route element={<ProtectedRoute><PortalLayout /></ProtectedRoute>}>
        <Route path="/portal" element={<PortalPage />} />
      </Route>
    </Routes>
  );
}
