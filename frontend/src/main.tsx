import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import "./index.css";
// Vendored 2990's brand tokens (CSS custom properties only — the global
// body/h1/table element resets from 2990's main.css are deliberately NOT
// imported, so the rest of Houzs is unaffected). Scopes via :root variables
// that the vendored /scm/* pages + design-system read from.
import "./vendor/design-system/tokens.css";
import { ToastProvider } from "./hooks/useToast";
import { DialogProvider } from "./hooks/useDialog";
import { AuthProvider } from "./auth/AuthContext";
import { AuthGate, AcceptInviteScreen } from "./auth/AuthScreens";
import { PwaBanners } from "./components/PwaBanners";
import { ChunkReloadBoundary } from "./components/RouteFallback";
import { registerPwa } from "./pwa";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";

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
// Invitation acceptance is a real public route (/invite/:token) so the
// set-password screen works even when a session already exists (e.g. the
// owner clicking the link while logged in). It needs AuthProvider for
// acceptInvite(), but renders OUTSIDE AuthGate so a live session doesn't
// short-circuit it into the dashboard.
const isInvite = path.startsWith("/invite/");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Top-level boundary: any render error (in Layout, Sidebar, a provider, or
        a route) shows a friendly reload panel instead of a white screen, and
        auto-reloads once on a stale-chunk error after a deploy. */}
    <ChunkReloadBoundary>
    <QueryClientProvider client={queryClient}>
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
        ) : isInvite ? (
          <AuthProvider>
            <Routes>
              <Route path="/invite/:token" element={<AcceptInviteScreen />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
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
    </QueryClientProvider>
    </ChunkReloadBoundary>
  </React.StrictMode>
);
