import { Routes, Route } from 'react-router-dom';
import DashboardLayout from './layouts/DashboardLayout';
import PortalLayout from './layouts/PortalLayout';
import { AdminRoute } from './components/layout/admin-route';

// Pages
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

export default function App() {
  return (
    <Routes>
      {/* Dashboard layout with sidebar */}
      <Route element={<DashboardLayout />}>
        <Route path="/" element={<DashboardPage />} />
        {/* Admin-only: SALES */}
        <Route path="/sales" element={<AdminRoute><SalesPage /></AdminRoute>} />
        <Route path="/sales/details" element={<AdminRoute><SODetailsPage /></AdminRoute>} />
        <Route path="/sales/orders" element={<AdminRoute><SalesOrderPage /></AdminRoute>} />
        <Route path="/sales/sku-costing" element={<AdminRoute><SKUCostingPage /></AdminRoute>} />
        {/* Legacy deep links: pre-select category */}
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
        {/* Admin-only: Finance */}
        <Route path="/finance" element={<AdminRoute><FinancePage /></AdminRoute>} />
        {/* Shared: PROJECT MANAGEMENT module (all sales can access) */}
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/pms" element={<PmsPage />} />
        <Route path="/settings" element={<AdminRoute><SettingsPage /></AdminRoute>} />
        <Route path="/events/new" element={<AdminRoute><NewEventPage /></AdminRoute>} />
        <Route path="/events/:id" element={<EventDetailPage />} />
      </Route>

      {/* Print pages — no sidebar */}
      <Route path="/qms/:id/print-customer" element={<PrintCustomerPage />} />
      <Route path="/qms/:id/print-supplier" element={<PrintSupplierPage />} />

      {/* Portal — separate layout */}
      <Route element={<PortalLayout />}>
        <Route path="/portal" element={<PortalPage />} />
      </Route>
    </Routes>
  );
}
