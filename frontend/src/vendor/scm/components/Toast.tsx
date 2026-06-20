// HOUZS VENDOR SHIM — Toast.
//
// 2990's Toast is a standalone <ToastProvider> + useToast() variant-toast stack
// (apps/backend/src/components/Toast.tsx). The vendored route shell
// (Scm2990Shell) mounts NotifyProvider + ConfirmProvider, not ToastProvider, so
// rather than add a second toast system this shim maps the same `ToastApi`
// surface (toast() callable + .success/.error/.warning/.info/.push) onto the
// in-app NotifyDialog the rest of the vendored SCM pages already use.
//
// Only `useToast` is consumed by the vendored SO Maintenance page; the
// ToastProvider export is kept as a no-op pass-through in case a later page
// expects to wrap a subtree.

import type { ReactNode } from 'react';
import { useNotify } from './NotifyDialog';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  duration?: number;
}

type PushFn = (message: string, opts?: ToastOptions) => void;

export interface ToastApi extends PushFn {
  success: PushFn;
  error: PushFn;
  warning: PushFn;
  info: PushFn;
  push: PushFn;
}

/** Bridge the variant-toast API onto useNotify (error → error tone, everything
 *  else → the default/neutral tone). */
export const useToast = (): ToastApi => {
  const notify = useNotify();
  const make = (variant: ToastVariant): PushFn => (message: string) => {
    notify({ title: message, tone: variant === 'error' ? 'error' : undefined });
  };
  const api = make('info') as ToastApi;
  api.success = make('success');
  api.error = make('error');
  api.warning = make('warning');
  api.info = make('info');
  api.push = make('info');
  return api;
};

/** No-op provider — the in-app NotifyProvider (mounted by Scm2990Shell) already
 *  supplies the toast surface, so this just renders its children. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
