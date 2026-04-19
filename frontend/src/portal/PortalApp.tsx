import { Routes, Route, Navigate } from "react-router-dom";
import { TrackForm } from "./pages/TrackForm";
import { PortalCaseDetailPage } from "./pages/PortalCaseDetail";

// Portal router. No auth context — the token lives entirely in the
// URL (/portal/case/:token) and is passed into portalApi explicitly
// on each request. /track is the public lookup form.

export function PortalApp() {
  return (
    <Routes>
      <Route path="/track" element={<TrackForm />} />
      <Route path="/portal/case/:token" element={<PortalCaseDetailPage />} />
      {/* Anything else under /portal bounces to the tracking form. */}
      <Route path="*" element={<Navigate to="/track" replace />} />
    </Routes>
  );
}
