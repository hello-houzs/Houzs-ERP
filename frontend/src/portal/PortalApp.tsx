import { Routes, Route, Navigate } from "react-router-dom";
import { TrackForm } from "./pages/TrackForm";
import { PortalCaseDetailPage } from "./pages/PortalCaseDetail";
import { PortalSupplierCasePage } from "./pages/PortalSupplierCase";

// Portal router. No auth context — the token lives entirely in the
// URL (/portal/case/:token or /portal/supplier/:token) and is passed
// into portalApi explicitly on each request. /track is the public
// lookup form for customers.

export function PortalApp() {
  return (
    <Routes>
      <Route path="/track" element={<TrackForm />} />
      <Route path="/portal/case/:token" element={<PortalCaseDetailPage />} />
      <Route path="/portal/supplier/:token" element={<PortalSupplierCasePage />} />
      {/* Anything else under /portal bounces to the tracking form. */}
      <Route path="*" element={<Navigate to="/track" replace />} />
    </Routes>
  );
}
