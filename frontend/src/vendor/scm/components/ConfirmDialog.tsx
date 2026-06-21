// ----------------------------------------------------------------------------
// ConfirmDialog / ConfirmProvider / useConfirm — app-wide in-app confirm modal
// for destructive or important actions (Commander 2026-06-15: edits & deletes
// must not be "裸奔" — ask first, in-app, never window.confirm). Same calm look
// as ActionResultDialog, but a Cancel + Confirm pair (optional danger-red).
//
// Mounted ONCE at the app root (main.tsx). Any component then gates an action:
//
//   const confirm = useConfirm();
//   ...
//   onClick={async () => {
//     if (await confirm({ title: 'Remove this line?', confirmLabel: 'Remove', danger: true })) {
//       deleteItem.mutate(...);
//     }
//   }}
//
// confirm() resolves true only when the user clicks Confirm; Cancel / backdrop /
// a superseding prompt all resolve false, so a dismissed prompt never acts.
// ----------------------------------------------------------------------------

import {
  createContext, useCallback, useContext, useState,
  type CSSProperties, type ReactNode,
} from 'react';

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  // 3000 — ABOVE every page modal (which top out ~1000). The confirm is
  // routinely raised FROM inside a modal (e.g. "Create N SKUs" in the bulk
  // New-Models dialog); at the old z-index 90 it rendered BEHIND that modal so
  // the button looked dead ("没反应"). Wei Siang 2026-06-20.
  zIndex: 3000, padding: 'var(--space-4)',
};
const card: CSSProperties = {
  background: 'var(--c-paper)', border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-3)',
  width: 'min(440px, 95vw)', padding: 'var(--space-5)',
};
const titleStyle: CSSProperties = {
  fontFamily: 'var(--font-title)', fontWeight: 700, fontSize: 'var(--fs-18, 18px)',
  color: 'var(--c-ink)', margin: '0 0 var(--space-2)',
};
const bodyStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)',
  margin: '0 0 var(--space-4)', whiteSpace: 'pre-wrap', lineHeight: 1.5,
};
const actions: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' };
const btnBase: CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 700,
  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
};
const ghostBtn: CSSProperties = { ...btnBase, border: '1px solid var(--line)', background: 'var(--c-paper)', color: 'var(--c-ink)' };
const primaryBtn: CSSProperties = { ...btnBase, border: '1px solid var(--c-orange)', background: 'var(--c-orange)', color: '#fff' };
const dangerBtn: CSSProperties = { ...btnBase, border: '1px solid var(--c-danger, #c0392b)', background: 'var(--c-danger, #c0392b)', color: '#fff' };

export type ConfirmOpts = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red Confirm button for destructive actions (delete / void). */
  danger?: boolean;
};

export type ConfirmDialogProps = ConfirmOpts & {
  onConfirm: () => void;
  onCancel: () => void;
};

export const ConfirmDialog = ({
  title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel,
}: ConfirmDialogProps) => (
  <div style={backdrop} onClick={onCancel} role="presentation">
    <div style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <h2 style={titleStyle}>{title}</h2>
      {body != null && <p style={bodyStyle}>{body}</p>}
      <div style={actions}>
        <button type="button" style={ghostBtn} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" style={danger ? dangerBtn : primaryBtn} onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
);

type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/* Mount once at the app root. Holds the live prompt state, renders the modal,
   and hands every descendant a confirm() through context. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => {
      // A new prompt supersedes any open one (resolve the old as cancelled).
      setState((prev) => { prev?.resolve(false); return { ...opts, resolve }; });
    }),
    [],
  );
  const settle = (v: boolean) => setState((s) => { s?.resolve(v); return null; });
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <ConfirmDialog
          title={state.title}
          body={state.body}
          confirmLabel={state.confirmLabel}
          cancelLabel={state.cancelLabel}
          danger={state.danger}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/* Gate an action behind an in-app confirm: `if (await confirm({…})) doIt()`. */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return confirm;
}
