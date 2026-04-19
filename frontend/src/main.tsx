import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import "./index.css";
import { ToastProvider } from "./hooks/useToast";
import { DialogProvider } from "./hooks/useDialog";
import { AuthProvider } from "./auth/AuthContext";
import { AuthGate } from "./auth/AuthScreens";
import { SurveyPublic } from "./pages/SurveyPublic";
import { PortalApp } from "./portal/PortalApp";
import { ResetPassword } from "./pages/ResetPassword";
import { PwaBanners } from "./components/PwaBanners";
import { registerPwa } from "./pwa";

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
    <BrowserRouter>
      <ToastProvider>
       <DialogProvider>
        {isSurvey ? (
          <SurveyPublic />
        ) : isPortal ? (
          <PortalApp />
        ) : isReset ? (
          <Routes>
            <Route path="/reset/:token" element={<ResetPassword />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
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
  </React.StrictMode>
);
