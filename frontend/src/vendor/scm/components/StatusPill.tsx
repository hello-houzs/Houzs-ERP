// StatusPill — the ONE status badge for every ERP document type. Backed by the
// canonical map in lib/status-pill.ts so a status looks + reads identically on
// every list, detail and drill-down. Replaces the per-page STATUS_COLOR /
// STATUS_CLASS / STATUS_LABEL / inline .statusPill copies.

import { resolveStatusPill, STATUS_TONES, type StatusDocType } from '../lib/status-pill';
import styles from './StatusPill.module.css';

export type StatusPillProps = {
  docType: StatusDocType;
  /** Raw enum status. For SO/DO/SI, pass the already-resolved EFFECTIVE status
      (after the soStatusDisplay / doEffectiveKey lifecycle overlay). */
  status: string | null | undefined;
  className?: string;
};

export function StatusPill({ docType, status, className }: StatusPillProps) {
  const { label, tone } = resolveStatusPill(docType, status);
  const { bg, fg } = STATUS_TONES[tone];
  return (
    <span className={`${styles.pill} ${className ?? ''}`} style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}
