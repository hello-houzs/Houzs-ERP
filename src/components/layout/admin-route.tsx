// Route guard — only renders children if the current user is an admin
// (Sales Director). Non-admins see an "Admin Only" card.

import { Link } from "react-router-dom";
import { ShieldAlert, ArrowLeft } from "lucide-react";
import { useCurrentUser, isAdmin } from "@/lib/auth-store";
import type { ReactNode } from "react";

export function AdminRoute({ children }: { children: ReactNode }) {
  const currentUser = useCurrentUser();
  if (isAdmin(currentUser)) return <>{children}</>;

  return (
    <div className="space-y-4 max-w-2xl">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-[#0F766E]">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Dashboard
      </Link>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-8 text-center">
        <ShieldAlert className="h-8 w-8 text-amber-400 mx-auto mb-3" />
        <div className="text-[14px] font-semibold text-amber-800">Admin Only</div>
        <div className="text-[12px] text-amber-700 mt-1">
          This page is restricted to Sales Directors.
        </div>
        <Link
          to="/"
          className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#0F766E] hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> Return to Dashboard
        </Link>
      </div>
    </div>
  );
}
