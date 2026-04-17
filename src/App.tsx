import { Routes, Route } from 'react-router-dom';
import DashboardLayout from './layouts/DashboardLayout';
import PortalLayout from './layouts/PortalLayout';

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
import SettingsPage from './pages/SettingsPage';
import PortalPage from './pages/PortalPage';

export default function App() {
  return (
    <Routes>
      {/* Dashboard layout with sidebar */}
      <Route element={<DashboardLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/bd" element={<BdPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/driver" element={<DriverPage />} />
        <Route path="/events/new" element={<NewEventPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/operation" element={<OperationPage />} />
        <Route path="/pms" element={<PmsPage />} />
        <Route path="/qms" element={<QmsPage />} />
        <Route path="/qms/:id" element={<QmsDetailPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
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
