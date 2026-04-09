import { useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button, IconButton } from "../components/Button";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { formatDate, formatNumber } from "../lib/utils";
import { parseCSVFile } from "../lib/csv";
import type { Paginated, PurchaseOrder, POSummary } from "../types";

export function PurchaseOrders() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:purchase-orders", 50);
  const [pulling, setPulling] = useState(false);

  const list = useQuery<Paginated<PurchaseOrder>>(
    () => api.get(`/api/po${buildQuery({ search, page, per_page: perPage })}`),
    [search, page, perPage]
  );

  const summary = useQuery<POSummary>(() => api.get("/api/po/summary"));

  async function refresh() {
    setPulling(true);
    try {
      await api.post("/api/po/pull");
      toast.success("Refreshed PO list");
      list.reload();
      summary.reload();
    } catch (e: any) {
      toast.error(`Refresh failed: ${e?.message || e}`);
    } finally {
      setPulling(false);
    }
  }

  async function patchRow(row: PurchaseOrder, body: Record<string, any>) {
    try {
      await api.patch(
        `/api/po/${encodeURIComponent(row.doc_no)}/${encodeURIComponent(row.item_code)}`,
        body
      );
      list.reload();
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message || e}`);
    }
  }

  async function syncDates(row: PurchaseOrder) {
    try {
      await api.post(`/api/po/${encodeURIComponent(row.doc_no)}/sync-dates`);
      toast.success(`Pushed dates for ${row.doc_no}`);
    } catch (e: any) {
      toast.error(`Push failed: ${e?.message || e}`);
    }
  }

  const dateInput = (
    row: PurchaseOrder,
    field: "supplier_date1" | "supplier_date2" | "supplier_date3"
  ) => (
    <input
      type="date"
      defaultValue={row[field] || ""}
      onBlur={(e) => {
        const v = e.target.value || null;
        if (v !== row[field]) patchRow(row, { [field]: v });
      }}
      className="h-7 w-32 rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
    />
  );

  const columns: Column<PurchaseOrder>[] = [
    {
      key: "doc_no",
      label: "PO No",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.doc_no}</span>,
      getValue: (r) => r.doc_no,
    },
    {
      key: "so_doc_no",
      label: "SO No",
      render: (r) => <span className="font-mono text-xs">{r.so_doc_no || "—"}</span>,
      getValue: (r) => r.so_doc_no,
    },
    {
      key: "creditor_name",
      label: "Supplier",
      render: (r) => r.creditor_name || "—",
      getValue: (r) => r.creditor_name,
    },
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      render: (r) => (
        <div className="max-w-[220px]">
          <div className="font-mono text-xs">{r.item_code}</div>
          <div className="truncate text-xs text-ink-muted">{r.item_description || ""}</div>
        </div>
      ),
      getValue: (r) => `${r.item_code} ${r.item_description || ""}`.trim(),
    },
    {
      key: "qty",
      label: "Qty",
      align: "right",
      render: (r) => <span className="font-mono text-xs">{formatNumber(r.remaining_qty)}</span>,
      getValue: (r) => r.remaining_qty,
    },
    {
      key: "delivery_date",
      label: "Delivery",
      render: (r) => formatDate(r.delivery_date),
      getValue: (r) => formatDate(r.delivery_date),
    },
    {
      key: "sd1",
      label: "Supplier 1",
      render: (r) => dateInput(r, "supplier_date1"),
      getValue: (r) => r.supplier_date1,
    },
    {
      key: "sd2",
      label: "Supplier 2",
      render: (r) => dateInput(r, "supplier_date2"),
      getValue: (r) => r.supplier_date2,
    },
    {
      key: "sd3",
      label: "Supplier 3",
      render: (r) => dateInput(r, "supplier_date3"),
      getValue: (r) => r.supplier_date3,
    },
    {
      key: "overdue_days",
      label: "Overdue",
      render: (r) => (
        <input
          type="text"
          defaultValue={r.overdue_days || ""}
          onBlur={(e) => {
            if (e.target.value !== (r.overdue_days || "")) {
              patchRow(r, { overdue_days: e.target.value || null });
            }
          }}
          className="h-7 w-16 rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
      ),
      getValue: (r) => r.overdue_days,
    },
    {
      key: "actions",
      label: "",
      alwaysVisible: true,
      align: "center",
      render: (r) => (
        <IconButton
          icon={<Send size={13} />}
          onClick={(e) => {
            e.stopPropagation();
            syncDates(r);
          }}
          aria-label="Push dates"
        />
      ),
    },
  ];

  /**
   * CSV import: expects "PO No" + "Item" (or "item_code") + any of the editable
   * supplier date / overdue columns. Each matched row is PATCH'd. Items are
   * matched by docNo+itemCode composite key. Imported supplier dates are NOT
   * pushed to AutoCount automatically — user can hit the row's send button after.
   */
  async function handleImport(file: File) {
    try {
      const rows = await parseCSVFile(file);
      if (!rows.length) {
        toast.error("CSV is empty");
        return;
      }
      const sample = rows[0];
      const docKey = ["PO No", "doc_no", "DocNo"].find((k) => k in sample);
      const itemKey =
        ["item_code", "Item", "ItemCode", "Item Code"].find((k) => k in sample);
      if (!docKey || !itemKey) {
        toast.error("CSV must include 'PO No' and 'item_code'");
        return;
      }
      const fieldMap: Record<string, string[]> = {
        supplier_date1: ["Supplier 1", "supplier_date1", "Supplier Date 1"],
        supplier_date2: ["Supplier 2", "supplier_date2", "Supplier Date 2"],
        supplier_date3: ["Supplier 3", "supplier_date3", "Supplier Date 3"],
        overdue_days: ["Overdue", "overdue_days", "Overdue Days"],
      };
      // Resolve which header maps to which db field
      const resolved: Record<string, string> = {};
      for (const [field, candidates] of Object.entries(fieldMap)) {
        const found = candidates.find((c) => c in sample);
        if (found) resolved[field] = found;
      }
      if (Object.keys(resolved).length === 0) {
        toast.error("CSV has no editable columns to import");
        return;
      }

      let updated = 0;
      let failed = 0;
      for (const row of rows) {
        const docNo = row[docKey];
        // The "Item" column may be "code description" — take the first whitespace token
        let itemCode = row[itemKey] || "";
        if (itemKey === "Item") itemCode = itemCode.split(/\s+/)[0];
        if (!docNo || !itemCode) continue;

        const body: Record<string, any> = {};
        for (const [field, header] of Object.entries(resolved)) {
          const v = row[header];
          body[field] = v === "" ? null : v;
        }
        try {
          await api.patch(
            `/api/po/${encodeURIComponent(docNo)}/${encodeURIComponent(itemCode)}`,
            body
          );
          updated++;
        } catch {
          failed++;
        }
      }
      toast.success(`Imported ${updated} row(s)${failed ? `, ${failed} failed` : ""}`);
      list.reload();
    } catch (e: any) {
      toast.error(`Import failed: ${e?.message || e}`);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Procurement"
        title="Purchase Orders"
        description="Edit supplier dates inline. Click send to push to AutoCount."
        actions={
          <Button
            variant="primary"
            icon={<RefreshCw size={14} />}
            onClick={refresh}
            disabled={pulling}
          >
            {pulling ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {(() => {
        const s = summary.data;
        return (
          <>
            <DashboardGrid cols={4}>
              <StatCard
                label="Open POs"
                value={s ? s.totals.po_count.toLocaleString() : "—"}
                subtitle={s ? `${s.totals.line_count.toLocaleString()} line items` : " "}
              />
              <StatCard
                label="Suppliers"
                value={s ? s.totals.supplier_count.toLocaleString() : "—"}
                subtitle="Distinct creditors"
              />
              <StatCard
                label="Overdue"
                value={s ? s.overdue.toLocaleString() : "—"}
                subtitle="Past delivery date"
                tone={s && s.overdue > 0 ? "error" : "default"}
              />
              <StatCard
                label="Missing Supplier Date"
                value={s ? s.missing_supplier_date.toLocaleString() : "—"}
                subtitle="No date1/2/3 set"
              />
            </DashboardGrid>

            <DashboardPanels cols={1}>
              <DashboardBreakdown
                title="Top Suppliers"
                items={
                  s?.top_suppliers.map((t) => ({ label: t.name, count: t.count })) ?? []
                }
              />
            </DashboardPanels>
          </>
        );
      })()}

      <DataTable
        tableId="purchase-orders"
        udfTable="purchase_orders"
        udfTableLabel="Purchase Orders"
        exportName="purchase-orders"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search PO no, supplier, item…",
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No purchase orders"
        getRowKey={(r) => r.id}
        onImport={handleImport}
      />

      {list.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}
    </div>
  );
}
