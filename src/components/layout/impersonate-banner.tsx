// Impersonation banner — shown at the top of the app when an admin is
// temporarily logged in AS another user for verification / troubleshooting.

import { UserCog, ArrowLeftFromLine, Loader2 } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/lib/auth-store";

export function ImpersonateBanner() {
  const { isImpersonating, user, impersonatedBy, stopImpersonate } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!isImpersonating || !user || !impersonatedBy) return null;

  async function handleStop() {
    setBusy(true);
    await stopImpersonate();
    setBusy(false);
  }

  return (
    <div className="flex items-center justify-between gap-3 bg-amber-100 border-b border-amber-300 px-4 py-1.5 text-[12px]">
      <div className="flex items-center gap-2 text-amber-900">
        <UserCog className="h-3.5 w-3.5" />
        <span>
          <b>{impersonatedBy.name}</b> impersonating <b>{user.name}</b>
          <span className="opacity-70 ml-1">({user.position})</span>
        </span>
      </div>
      <button
        onClick={handleStop}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-50 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowLeftFromLine className="h-3 w-3" />}
        Return to admin
      </button>
    </div>
  );
}
