export type Env = {
  DB: D1Database;
  POD_BUCKET: R2Bucket;
  AUTOCOUNT_API_URL: string;
  AUTOCOUNT_API_KEY: string;
  DASHBOARD_API_KEY: string;
  GOOGLE_MAPS_API_KEY?: string;
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
