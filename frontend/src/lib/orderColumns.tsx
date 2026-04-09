import type { Column } from "../components/DataTable";
import { StatusDot } from "../components/StatusDot";
import type { SalesOrder } from "../types";
import { cn, formatCurrency, formatDate, isExpired } from "./utils";

/**
 * Shared column set used by every page that displays rows from the
 * D1 `sales_orders` table (Sales Orders, Delivery Orders, Balance, …).
 *
 * Both pages get the *same* column count and the *same* identifiers,
 * so a custom UDF added on one page surfaces on the other, the column
 * chooser shows the same options, and CSV export produces the same
 * shape regardless of which view exported it.
 */
export function getSalesOrderColumns(): Column<SalesOrder>[] {
  const truncated = (v: string | null | undefined, w = 200) => (
    <span className="block truncate" style={{ maxWidth: w }}>
      {v || "—"}
    </span>
  );

  return [
    {
      key: "remark4",
      label: "Delivery Message Status",
      render: (r) => (
        <span className="text-xs text-ink-secondary">{r.remark4 || "—"}</span>
      ),
      getValue: (r) => r.remark4,
    },
    {
      key: "doc_no",
      label: "Doc No",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.doc_no}</span>,
      getValue: (r) => r.doc_no,
    },
    {
      key: "transfer_to",
      label: "D/O",
      render: (r) => <span className="font-mono text-xs">{r.transfer_to || "—"}</span>,
      getValue: (r) => r.transfer_to,
    },
    {
      key: "doc_date",
      label: "Date",
      render: (r) => formatDate(r.doc_date),
      getValue: (r) => formatDate(r.doc_date),
    },
    {
      key: "ref",
      label: "Ref",
      render: (r) => truncated(r.ref, 140),
      getValue: (r) => r.ref,
    },
    {
      key: "branding",
      label: "Branding",
      render: (r) => truncated(r.branding, 140),
      getValue: (r) => r.branding,
    },
    {
      key: "debtor_name",
      label: "Customer",
      render: (r) => truncated(r.debtor_name, 200),
      getValue: (r) => r.debtor_name,
    },
    {
      key: "phone",
      label: "Phone",
      render: (r) => <span className="font-mono text-xs">{r.phone || "—"}</span>,
      getValue: (r) => r.phone,
    },
    {
      key: "sales_agent",
      label: "Agent",
      render: (r) => truncated(r.sales_agent, 140),
      getValue: (r) => r.sales_agent,
    },
    {
      key: "sales_location",
      label: "Loc",
      align: "center",
      render: (r) => (
        <span className="rounded-md border border-border bg-bg px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
          {r.sales_location || "—"}
        </span>
      ),
      getValue: (r) => r.sales_location,
    },
    {
      key: "local_total",
      label: "Total",
      align: "right",
      render: (r) => <span className="font-mono text-xs">{formatCurrency(r.local_total)}</span>,
      getValue: (r) => r.local_total,
    },
    {
      key: "balance",
      label: "Balance",
      align: "right",
      render: (r) => (
        <span
          className={cn(
            "font-mono text-xs",
            r.balance > 0 && "font-semibold",
            isExpired(r.expiry_date) && r.balance > 0 && "text-err"
          )}
        >
          {formatCurrency(r.balance)}
        </span>
      ),
      getValue: (r) => r.balance,
    },
    {
      key: "remark2",
      label: "Remark 2",
      render: (r) => truncated(r.remark2, 160),
      getValue: (r) => r.remark2,
    },
    {
      key: "remark3",
      label: "Remark 3",
      render: (r) => truncated(r.remark3, 160),
      getValue: (r) => r.remark3,
    },
    {
      key: "processing_date",
      label: "Processing",
      render: (r) => formatDate(r.processing_date),
      getValue: (r) => formatDate(r.processing_date),
    },
    {
      key: "expiry_date",
      label: "Expiry",
      render: (r) => formatDate(r.expiry_date),
      getValue: (r) => formatDate(r.expiry_date),
    },
    {
      key: "note",
      label: "Note",
      render: (r) => truncated(r.note, 180),
      getValue: (r) => r.note,
    },
    {
      key: "po_doc_no",
      label: "PO No",
      render: (r) => <span className="font-mono text-xs">{r.po_doc_no || "—"}</span>,
      getValue: (r) => r.po_doc_no,
    },
    {
      key: "inv_addr1",
      label: "Addr 1",
      render: (r) => truncated(r.inv_addr1, 180),
      getValue: (r) => r.inv_addr1,
    },
    {
      key: "inv_addr2",
      label: "Addr 2",
      render: (r) => truncated(r.inv_addr2, 180),
      getValue: (r) => r.inv_addr2,
    },
    {
      key: "inv_addr3",
      label: "Addr 3",
      render: (r) => truncated(r.inv_addr3, 180),
      getValue: (r) => r.inv_addr3,
    },
    {
      key: "inv_addr4",
      label: "Addr 4",
      render: (r) => truncated(r.inv_addr4, 180),
      getValue: (r) => r.inv_addr4,
    },
    {
      key: "venue",
      label: "Venue",
      render: (r) => truncated(r.venue, 160),
      getValue: (r) => r.venue,
    },
    {
      key: "attention",
      label: "Attention",
      render: (r) => truncated(r.attention, 140),
      getValue: (r) => r.attention,
    },
    {
      key: "sync_status",
      label: "Sync",
      align: "center",
      render: (r) => <StatusDot variant={r.sync_status === "SYNCED" ? "synced" : "error"} />,
      getValue: (r) => r.sync_status,
    },
  ];
}
