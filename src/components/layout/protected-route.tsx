// ProtectedRoute — wraps any route that requires an authenticated session.
// Behavior:
//   • status === "loading"   → spinner (cookie check in-flight)
//   • status === "guest"     → redirect to /login?from=<current path>
//   • status === "authenticated" but must-change-password → redirect /change-password
//   • otherwise render children

import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuthState } from "@/lib/auth-store";
import { Loader2 } from "lucide-react";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, user } = useAuthState();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[#0F766E]" />
      </div>
    );
  }

  if (status === "guest" || !user) {
    const from = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?from=${from}`} replace />;
  }

  // Force password change post-invite, before anything else
  if (user.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }

  return <>{children}</>;
}
