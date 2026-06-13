import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import "./index.css";
import { ToastProvider } from "./hooks/useToast";
import { DialogProvider } from "./hooks/useDialog";
import { AuthProvider } from "./auth/AuthContext";
import { AuthGate } from "./auth/AuthScreens";
import { PwaBanners } from "./components/PwaBanners";
import { ChunkReloadBoundary } from "./components/RouteFallback";
import { registerPwa } from "./pwa";

// The public surfaces (survey, customer/supplier portal, password reset)
// are split out of the staff bundle — staff never download them, and the
// public flows skip the whole dashboard bundle in return.
const SurveyPublic = lazy(() => import("./pages/SurveyPublic").then((m) => ({ default: m.SurveyPublic })));
const PortalApp = lazy(() => import("./portal/PortalApp").then((m) => ({ default: m.PortalApp })));
const ResetPassword = lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })));

function PublicFallback() {
  return <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">Loading</div>;
}

// Register the service worker + capture installability events.
// Safe on every page (survey/portal/supplier all benefit too).
registerPwa();

// Public routes that must bypass the staff AuthGate entirely:
//   /survey/:token       — tokenized customer satisfaction survey
//   /track               — public case-lookup form (ASSR no + phone)
//   /portal/case/:token  — customer-facing case view scoped by token
// Detected by URL prefix up front so AuthProvider / AuthGate never
// even get mounted for these trees.
const path = window.location.pathname;
const isSurvey = path.startsWith("/survey/");
const isPortal = path === "/track" || path.startsWith("/track/") ||
                 path === "/portal" || path.startsWith("/portal/");
const isReset = path.startsWith("/reset/");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Top-level boundary: any render error (in Layout, Sidebar, a provider, or
        a route) shows a friendly reload panel instead of a white screen, and
        auto-reloads once on a stale-chunk error after a deploy. */}
    <ChunkReloadBoundary>
    <BrowserRouter>
      <ToastProvider>
       <DialogProvider>
        {isSurvey ? (
          <Suspense fallback={<PublicFallback />}>
            <SurveyPublic />
          </Suspense>
        ) : isPortal ? (
          <Suspense fallback={<PublicFallback />}>
            <PortalApp />
          </Suspense>
        ) : isReset ? (
          <Suspense fallback={<PublicFallback />}>
            <Routes>
              <Route path="/reset/:token" element={<ResetPassword />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        ) : (
          <AuthProvider>
            <AuthGate>
              <App />
            </AuthGate>
          </AuthProvider>
        )}
        <PwaBanners />
       </DialogProvider>
      </ToastProvider>
    </BrowserRouter>
    </ChunkReloadBoundary>
  </React.StrictMode>
);
