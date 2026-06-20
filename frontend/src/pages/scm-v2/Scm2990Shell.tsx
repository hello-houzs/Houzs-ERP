// Scm2990Shell — the shared app-shell wrapper for every VENDORED 2990's SCM
// page mounted at a parallel /scm/* route. Extracted from the original
// SuppliersV2Route so the PO pages (and future domains) can reuse the exact
// same provider setup instead of each re-declaring it.
//
// The vendored page tree expects three things from its host that 2990's
// provides at its own root but Houzs's main.tsx does not:
//   1. <NotifyProvider>  — supplies useNotify() (create / save / error toasts).
//   2. <ConfirmProvider> — supplies useConfirm() (the in-app "are you sure?"
//      gate the PO detail/list use for Cancel / Reopen / Delete / remove-line).
//      The Suppliers slice never needed this (the list raises no confirm), so
//      the original route stubbed confirm with window.confirm; the PO pages DO
//      call useConfirm(), so it's mounted here for real.
//   3. dialog-service registration — so authedFetch's 409 short-stock confirm
//      and any serviceNotify land in THESE in-app dialogs instead of a naked
//      window.confirm / window.alert. Wired via the bridge below, which now
//      registers the real useConfirm (not the window.confirm fallback).
//
// All providers are scoped to this subtree, so they can't clash with Houzs's
// own toast / dialog providers. QueryClientProvider + BrowserRouter already
// exist in main.tsx and @tanstack/react-query is shared, so the vendored hooks
// just work.

import { useEffect, type ReactNode } from 'react';
import { NotifyProvider, useNotify } from '../../vendor/scm/components/NotifyDialog';
import { ConfirmProvider, useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { PromptProvider } from '../../vendor/scm/components/PromptDialog';
import { registerDialogService } from '../../vendor/scm/lib/dialog-service';

/** Registers the live confirm + notify fns with the module-level dialog-service
 *  bridge so non-React callers (authedFetch's short-stock gate, query onError
 *  toasts) raise the in-app dialogs. Must render inside BOTH providers. */
function DialogServiceBridge() {
  const notify = useNotify();
  const confirm = useConfirm();
  useEffect(() => {
    registerDialogService({ confirm, notify });
  }, [confirm, notify]);
  return null;
}

export function Scm2990Shell({ children }: { children: ReactNode }) {
  return (
    <NotifyProvider>
      <ConfirmProvider>
        <PromptProvider>
          <DialogServiceBridge />
          <div className="scm2990">{children}</div>
        </PromptProvider>
      </ConfirmProvider>
    </NotifyProvider>
  );
}

export default Scm2990Shell;
