export type Env = {
  // During the D1 -> Supabase cutover, `DB` is injected per request/cron with
  // a D1-compatible shim over Postgres (see middleware/db.ts). The legacy D1
  // binding may stay in wrangler.toml until the cutover is verified.
  DB: D1Database;
  // Cloudflare Hyperdrive over the Supabase pooler (prod). Local dev / scripts
  // read DATABASE_URL from .dev.vars instead.
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  POD_BUCKET: R2Bucket;
  AUTOCOUNT_API_URL: string;
  AUTOCOUNT_API_KEY: string;
  // Inbound-sync kill switch. "true" = skip every AutoCount pull (cron + manual).
  AUTOCOUNT_SYNC_DISABLED?: string;
  DASHBOARD_API_KEY: string;
  GOOGLE_MAPS_API_KEY?: string;
  // Email (Resend). Leave RESEND_API_KEY unset to run in no-op mode —
  // send() will log + skip, never throw.
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;        // e.g. "Houzs ERP <no-reply@houzs.com>"
  EMAIL_REPLY_TO?: string;
  // Public origin for building email links (portal survey URLs etc.).
  // Falls back to the worker URL if unset.
  PUBLIC_APP_URL?: string;
};

export type Region = "WEST" | "EAST" | "SG";
export type SyncStatus = "SYNCED" | "ERROR";

// Raw API shape from AutoCount middleware
export interface ACSalesOrder {
  DocNo: string;
  TransferTo?: string | null;
  DocDate?: string | null;
  Ref?: string | null;
  SOUDF_BRANDING?: string | null;
  DebtorName?: string | null;
  Phone1?: string | null;
  SalesLocation?: string | null;
  SalesAgent?: string | null;
  Total?: number | null;
  SOUDF_BALANCE?: number | null;
  Remark2?: string | null;
  Remark3?: string | null;
  Remark4?: string | null;
  SOUDF_PDate?: string | null;
  SalesExemptionExpiryDate?: string | null;
  SOUDF_Note?: string | null;
  SOUDF_ToPONo?: string | null;
  InvAddr1?: string | null;
  InvAddr2?: string | null;
  InvAddr3?: string | null;
  InvAddr4?: string | null;
  SOUDF_VENUE?: string | null;
  Attention?: string | null;
  LastModified?: string | null;
}

// Line-item detail for a single Sales Order from AutoCount's
// /SalesOrder/getDetail/{docNo} endpoint. Field names mirror the
// middleware response; shape is flexible since installs vary.
export interface ACSalesOrderDetail {
  DocNo?: string;
  ItemCode?: string | null;
  Description?: string | null;
  ItemDescription?: string | null;
  Qty?: number | null;
  UOM?: string | null;
  UnitPrice?: number | null;
  Amount?: number | null;
  [key: string]: any;
}

export interface ACPurchaseOrder {
  DocNo: string;
  SODocNo?: string | null;
  CreditorCode?: string | null;
  CreditorName?: string | null;
  ItemCode: string;
  ItemDescription?: string | null;
  Location?: string | null;
  DocDate?: string | null;
  RemainingQty?: number | null;
  DeliveryDate?: string | null;
  SupplierDeliveryDate1?: string | null;
  SupplierDeliveryDate2?: string | null;
  SupplierDeliveryDate3?: string | null;
  // (Legacy) Money fields from the line payload. AutoCount's
  // getOutstanding doesn't expose these for our middleware version, so
  // they're optional and the sync falls back to manual entry. Kept on
  // the line type so existing /getOutstanding consumers stay clean.
  //   • UnitPrice               — raw per-unit price (foreign currency)
  //   • UnitPriceAfterDiscount  — per-unit after the line discount
  //   • SubTotal                — line total (Qty × UnitPriceAfterDiscount), foreign
  //   • LocalSubTotal           — line total in local currency (preferred)
  //   • LocalSubTotalExTax      — local line total before tax
  // The sync prefers LocalSubTotal so the P&L is in RM. When that's
  // missing it computes UnitPriceAfterDiscount × RemainingQty so the
  // *outstanding commitment* still surfaces.
  UnitPrice?: number | null;
  UnitPriceAfterDiscount?: number | null;
  SubTotal?: number | null;
  LocalSubTotal?: number | null;
  LocalSubTotalExTax?: number | null;
  [key: string]: any;
}

/**
 * Doc-level Purchase Order from /PurchaseOrder/getAll. One row per PO
 * document — no line items. Used for cost roll-ups (P&L) and for the
 * "Documents" view on the PO page.
 *
 * `LocalExTax` is the line-item subtotal in local currency, ex-tax —
 * what we want for cost analysis. `LocalNetTotal` is the same with
 * tax. `Cancelled` is "T"/"F" string from AutoCount.
 */
export interface ACPurchaseOrderDoc {
  DocNo: string;
  DocDate?: string | null;
  Ref?: string | null;
  POUDF_SONo?: string | null;
  CreditorCode?: string | null;
  CreditorName?: string | null;
  PurchaseLocation?: string | null;
  DocStatus?: string | null;
  Cancelled?: string | boolean | number | null;
  ExTax?: number | null;
  LocalExTax?: number | null;
  Tax?: number | null;
  LocalTax?: number | null;
  NetTotal?: number | null;
  LocalNetTotal?: number | null;
  Total?: number | null;
  TotalWithTax?: number | null;
  FinalTotal?: number | null;
  CurrencyCode?: string | null;
  CurrencyRate?: number | null;
  Remark1?: string | null;
  Remark2?: string | null;
  Remark3?: string | null;
  Remark4?: string | null;
  Note?: string | null;
  LastModified?: string | null;
  [key: string]: any;
}

export interface SalesOrderRow {
  id: number;
  doc_no: string;
  region: Region;
  transfer_to: string | null;
  doc_date: string | null;
  ref: string | null;
  branding: string | null;
  debtor_name: string | null;
  phone: string | null;
  sales_location: string | null;
  sales_agent: string | null;
  local_total: number;
  balance: number;
  remark2: string | null;
  remark3: string | null;
  remark4: string | null;
  processing_date: string | null;
  expiry_date: string | null;
  note: string | null;
  po_doc_no: string | null;
  inv_addr1: string | null;
  inv_addr2: string | null;
  inv_addr3: string | null;
  inv_addr4: string | null;
  venue: string | null;
  sync_status: SyncStatus;
  sync_error: string | null;
  last_modified: string | null;
  created_at: string;
  updated_at: string;
}
