// Canonical status → {label, tone} maps for every ERP document type, plus the
// tone palette. ONE source of truth so a status looks + reads identically on
// every list, detail and drill-down (Commander 2026-06-18 — "统一 UI/范例").
//
// Background tints are lifted verbatim from the pre-existing list/detail pills
// so adoption is visually conservative (same colours, just centralised); the
// only deliberate change is that list pills now also tint the TEXT (tone.fg),
// matching what the detail pages already did.
//
// Lifecycle note: SO / DO / SI also carry a document-driven "effective" status
// (see lib/so-status.ts soStatusDisplay / doEffectiveKey). Those callers must
// resolve the effective raw status FIRST, then pass it here.

export type StatusTone = 'neutral' | 'info' | 'progress' | 'success' | 'danger' | 'pending';

export const STATUS_TONES: Record<StatusTone, { bg: string; fg: string }> = {
  neutral:  { bg: 'rgba(34, 31, 32, 0.08)',   fg: 'var(--fg-muted)' },
  info:     { bg: 'rgba(166, 71, 30, 0.12)',  fg: 'var(--c-burnt)' },
  progress: { bg: 'rgba(166, 71, 30, 0.18)',  fg: 'var(--c-burnt)' },
  success:  { bg: 'rgba(47, 93, 79, 0.28)',   fg: 'var(--c-secondary-a, #2F5D4F)' },
  danger:   { bg: 'rgba(184, 51, 31, 0.10)',  fg: 'var(--c-festive-b, #B8331F)' },
  pending:  { bg: 'rgba(214, 158, 46, 0.18)', fg: '#8a5a00' },
};

export type StatusDocType =
  | 'po' | 'grn' | 'pi' | 'pr'
  | 'so' | 'do' | 'si' | 'dr'
  | 'stockTransfer' | 'stockTake';

type Entry = { label: string; tone: StatusTone };

const PO: Record<string, Entry> = {
  SUBMITTED:          { label: 'Confirmed',          tone: 'info' },
  PARTIALLY_RECEIVED: { label: 'Partially Received', tone: 'progress' },
  RECEIVED:           { label: 'Received',           tone: 'success' },
  CANCELLED:          { label: 'Cancelled',          tone: 'danger' },
};
const GRN: Record<string, Entry> = {
  POSTED:    { label: 'Confirmed', tone: 'info' },
  CLOSED:    { label: 'Closed',    tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};
const PI: Record<string, Entry> = {
  POSTED:         { label: 'Confirmed',      tone: 'info' },
  PARTIALLY_PAID: { label: 'Partially Paid', tone: 'progress' },
  PAID:           { label: 'Paid',           tone: 'success' },
  CANCELLED:      { label: 'Cancelled',      tone: 'danger' },
};
const PR: Record<string, Entry> = {
  POSTED:    { label: 'Confirmed', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};
const SO: Record<string, Entry> = {
  CONFIRMED:     { label: 'Confirmed',     tone: 'info' },
  IN_PRODUCTION: { label: 'Proceed',       tone: 'progress' },
  READY_TO_SHIP: { label: 'Ready to Ship', tone: 'success' },
  SHIPPED:       { label: 'Shipped',       tone: 'success' },
  DELIVERED:     { label: 'Delivered',     tone: 'success' },
  INVOICED:      { label: 'Invoiced',      tone: 'neutral' },
  CLOSED:        { label: 'Closed',        tone: 'neutral' },
  ON_HOLD:       { label: 'On Hold',       tone: 'progress' },
  RETURNED:      { label: 'Returned',      tone: 'pending' },
  CANCELLED:     { label: 'Cancelled',     tone: 'danger' },
};
const DO: Record<string, Entry> = {
  LOADED:     { label: 'Loaded',     tone: 'info' },
  DISPATCHED: { label: 'Shipped',    tone: 'progress' },
  IN_TRANSIT: { label: 'In Transit', tone: 'progress' },
  SIGNED:     { label: 'Signed',     tone: 'success' },
  DELIVERED:  { label: 'Delivered',  tone: 'success' },
  INVOICED:   { label: 'Invoiced',   tone: 'neutral' },
  CANCELLED:  { label: 'Cancelled',  tone: 'danger' },
};
const SI: Record<string, Entry> = {
  SENT:           { label: 'Issued',         tone: 'info' },
  PARTIALLY_PAID: { label: 'Partially Paid', tone: 'progress' },
  PAID:           { label: 'Paid',           tone: 'success' },
  OVERDUE:        { label: 'Overdue',        tone: 'danger' },
  CANCELLED:      { label: 'Cancelled',      tone: 'danger' },
};
const DR: Record<string, Entry> = {
  PENDING:      { label: 'Pending',      tone: 'info' },
  RECEIVED:     { label: 'Received',     tone: 'success' },
  INSPECTED:    { label: 'Inspected',    tone: 'success' },
  REFUNDED:     { label: 'Refunded',     tone: 'success' },
  CREDIT_NOTED: { label: 'Credit Noted', tone: 'success' },
  CANCELLED:    { label: 'Cancelled',    tone: 'danger' },
};
const STOCK_TRANSFER: Record<string, Entry> = {
  POSTED:    { label: 'Posted',    tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};
const STOCK_TAKE: Record<string, Entry> = {
  OPEN:      { label: 'Open',      tone: 'neutral' },
  POSTED:    { label: 'Posted',    tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

const MAPS: Record<StatusDocType, Record<string, Entry>> = {
  po: PO, grn: GRN, pi: PI, pr: PR,
  so: SO, do: DO, si: SI, dr: DR,
  stockTransfer: STOCK_TRANSFER, stockTake: STOCK_TAKE,
};

const titleCase = (raw: string): string =>
  raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Resolve a raw status to its canonical {label, tone}. Unknown → neutral
 *  with a humanised label, so a new enum value never renders blank or raw. */
export function resolveStatusPill(docType: StatusDocType, status: string | null | undefined): Entry {
  const s = String(status ?? '').toUpperCase();
  return MAPS[docType][s] ?? { label: status ? titleCase(String(status)) : '—', tone: 'neutral' };
}

/** Canonical human label only — for DataGrid searchValue / groupValue / filter
 *  chips, where the pill JSX isn't wanted but the text must match. */
export function statusLabel(docType: StatusDocType, status: string | null | undefined): string {
  return resolveStatusPill(docType, status).label;
}
