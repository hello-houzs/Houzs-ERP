import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { DataTable } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { InlineEdit } from "../components/InlineEdit";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import { parseCSVFile } from "../lib/csv";
import { getSalesOrderColumns } from "../lib/orderColumns";
import type { Paginated, SalesOrder, OrderDetails, Region, OrdersSummary } from "../types";

type RegionFilter = "ALL" | Region;

// Delivery Message Status options (stored in AutoCount Remark4).
// Add new statuses here — the dropdown and the table both use this list.
const DELIVERY_MESSAGE_STATUSES = [
  "to send delivery date",
  "pending customer reply (D)",
  "pending reschedule (D)",
  "done scheduling",
  "not sent (D)",
  "Pending Reschedule (A)",
  "Not sent (A)",
] as const;

export function Orders() {
  const toast = useToast();
  const [region, setRegion] = useState<RegionFilter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:orders", 50);
  const [selected, setSelected] = useState<SalesOrder | null>(null);
  const [syncing, setSyncing] = useState(false);

  const list = useQuery<Paginated<SalesOrder>>(
    () =>
      api.get(
        `/api/orders${buildQuery({
          region: region === "ALL" ? undefined : region,
          search,
          page,
          per_page: perPage,
        })}`
      ),
    [region, search, page, perPage]
  );

  const summary = useQuery<OrdersSummary>(() => api.get("/api/orders/summary"));

  const detail = useQuery<{ order: SalesOrder; details: OrderDetails | null }>(
    () =>
      selected
        ? api.get(`/api/orders/${encodeURIComponent(selected.doc_no)}`)
        : Promise.resolve({ order: null as any, details: null }),
    [selected?.doc_no]
  );

  const columns = getSalesOrderColumns();

  /**
   * CSV import: expects a header row containing at least "Doc No". For each row,
   * if "Status" (remark4) or "Expiry" (expiry_date) differs, push the change.
   * The push triggers an immediate AutoCount update.
   */
  async function handleImport(file: File) {
    try {
      const rows = await parseCSVFile(file);
      if (!rows.length) {
        toast.error("CSV is empty");
        return;
      }
      const sample = rows[0];
      // tolerate either label "Doc No" or key "doc_no"
      const docKey =
        ["Doc No", "doc_no", "DocNo"].find((k) => k in sample) ?? null;
      if (!docKey) {
        toast.error("CSV must include a 'Doc No' column");
        return;
      }
      const remarkKey = ["Status", "remark4", "Remark 4"].find((k) => k in sample);
      const expiryKey = ["Expiry", "expiry_date", "Expiry Date"].find((k) => k in sample);
      if (!remarkKey && !expiryKey) {
        toast.error("CSV must include 'Status' or 'Expiry' to update");
        return;
      }

      let updated = 0;
      let failed = 0;
      for (const row of rows) {
        const docNo = row[docKey];
        if (!docNo) continue;
        const body: Record<string, any> = {};
        if (remarkKey) body.remark4 = row[remarkKey] || null;
        if (expiryKey) body.expiry_date = row[expiryKey] || null;
        try {
          await api.patch(`/api/orders/${encodeURIComponent(docNo)}`, body);
          updated++;
        } catch (e) {
          failed++;
        }
      }
      toast.success(`Imported ${updated} row(s)${failed ? `, ${failed} failed` : ""}`);
      list.reload();
    } catch (e: any) {
      toast.error(`Import failed: ${e?.message || e}`);
    }
  }

  async function runSync() {
    setSyncing(true);
    try {
      // Full backfill via AutoCount /SalesOrder/getAll. The */5 cron continues
      // to handle incremental updates via getSince.
      await api.post("/api/sync/pull?mode=all");
      toast.success("Sync complete");
      list.reload();
      summary.reload();
    } catch (e: any) {
      toast.error(`Sync failed: ${e?.message || e}`);
    } finally {
      setSyncing(false);
    }
  }

  async function patchOrder(docNo: string, body: Record<string, any>) {
    const res: any = await api.patch(`/api/orders/${encodeURIComponent(docNo)}`, body);
    if (res?.sync_status === "ERROR") {
      throw new Error(res.sync_error || "Push failed");
    }
    list.reload();
    detail.reload();
  }

  async function patchDetails(docNo: string, body: Record<string, any>) {
    await api.patch(`/api/orders/${encodeURIComponent(docNo)}/details`, body);
    detail.reload();
  }

  const order = detail.data?.order ?? selected;
  const details = detail.data?.details ?? null;
  const isEast = order?.region === "EAST";

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Sales"
        title="Sales Orders"
        description="Edit fields auto-save and push to AutoCount"
        actions={
          <Button
            variant="primary"
            icon={<RefreshCw size={14} />}
            onClick={runSync}
            disabled={syncing}
          >
            {syncing ? "Syncing…" : "Sync"}
          </Button>
        }
      />

      {(() => {
        const s = summary.data?.all;
        const statusEntries = s
          ? Object.entries(s.by_status).sort((a, b) => b[1] - a[1]).slice(0, 6)
          : [];
        return (
          <>
            <DashboardGrid cols={4}>
              <StatCard
                label="Total Orders"
                value={s ? s.total.toLocaleString() : "—"}
                subtitle={
                  s
                    ? `West ${s.by_region.WEST ?? 0} · East ${s.by_region.EAST ?? 0} · SG ${
                        s.by_region.SG ?? 0
                      } · Other ${s.by_region.OTHER ?? 0}`
                    : " "
                }
              />
              <StatCard
                label="Outstanding"
                value={s ? formatCurrency(s.total_balance, { compact: true }) : "—"}
                subtitle={s ? `${s.outstanding_count.toLocaleString()} orders with balance` : " "}
              />
              <StatCard
                label="Expired"
                value={s ? s.expired.toLocaleString() : "—"}
                subtitle={s ? `${s.expiring_7d} expiring in 7 days` : " "}
                tone={s && s.expired > 0 ? "error" : "default"}
              />
              <StatCard
                label="No Expiry Set"
                value={s ? s.no_expiry.toLocaleString() : "—"}
                subtitle="Missing SalesExemptionExpiryDate"
              />
            </DashboardGrid>

            <DashboardPanels cols={2}>
              <DashboardBreakdown
                title="By Region"
                items={
                  s
                    ? (["WEST", "EAST", "SG", "OTHER"] as const).map((k) => ({
                        label: k === "OTHER" ? "Other" : k,
                        count: s.by_region[k] ?? 0,
                      }))
                    : []
                }
              />
              <DashboardBreakdown
                title="By Delivery Message Status (Top 6)"
                items={statusEntries.map(([k, v]) => ({ label: k, count: v }))}
              />
            </DashboardPanels>
          </>
        );
      })()}

      <div className="mb-4">
        <FilterPills
          value={region}
          onChange={(v) => {
            setPage(1);
            setRegion(v);
          }}
          options={[
            { value: "ALL", label: "All" },
            { value: "WEST", label: "West" },
            { value: "EAST", label: "East" },
            { value: "SG", label: "SG" },
          ]}
        />
      </div>

      <DataTable
        tableId="orders"
        udfTable="sales_orders"
        udfTableLabel="Sales Orders"
        exportName="orders"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search doc no, customer, phone…",
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No orders found"
        getRowKey={(r) => r.doc_no}
        onRowClick={(r) => setSelected(r)}
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

      <Panel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.doc_no || ""}
        subtitle={selected?.debtor_name || ""}
      >
        {order && (
          <>
            <PanelSection title="Order" muted>
              <FieldRow label="Doc No" mono>
                {order.doc_no}
              </FieldRow>
              <FieldRow label="D/O">{order.transfer_to || "—"}</FieldRow>
              <FieldRow label="Date">{formatDate(order.doc_date)}</FieldRow>
              <FieldRow label="Ref">{order.ref || "—"}</FieldRow>
              <FieldRow label="Agent">{order.sales_agent || "—"}</FieldRow>
              <FieldRow label="Total" mono>
                {formatCurrency(order.local_total)}
              </FieldRow>
              <FieldRow label="Balance" mono>
                <span className={cn(order.balance > 0 && "font-semibold text-err")}>
                  {formatCurrency(order.balance)}
                </span>
              </FieldRow>
            </PanelSection>

            <PanelSection title="Delivery (auto-pushed)">
              <InlineEdit
                label="Delivery Message Status"
                value={order.remark4}
                options={DELIVERY_MESSAGE_STATUSES}
                onSave={(v) => patchOrder(order.doc_no, { remark4: v })}
              />
              <InlineEdit
                label="Expiry Date"
                type="date"
                value={order.expiry_date}
                onSave={(v) => patchOrder(order.doc_no, { expiry_date: v })}
              />
              <InlineEdit
                label="Delivery Date"
                type="date"
                value={details?.delivery_date}
                onSave={(v) => patchDetails(order.doc_no, { delivery_date: v })}
              />
              <InlineEdit
                label="Time Range"
                value={details?.time_range}
                onSave={(v) => patchDetails(order.doc_no, { time_range: v })}
              />
              <InlineEdit
                label="Driver"
                value={details?.driver_name}
                onSave={(v) => patchDetails(order.doc_no, { driver_name: v })}
              />
              <InlineEdit
                label="Lorry Plate"
                value={details?.lorry_plate}
                onSave={(v) => patchDetails(order.doc_no, { lorry_plate: v })}
              />
              <InlineEdit
                label="Driver Contact"
                value={details?.driver_contact}
                onSave={(v) => patchDetails(order.doc_no, { driver_contact: v })}
              />
            </PanelSection>

            <PanelSection title="Address" muted>
              <div className="space-y-1 text-sm text-ink-secondary">
                <div>{order.inv_addr1 || "—"}</div>
                <div>{order.inv_addr2 || ""}</div>
                <div>{order.inv_addr3 || ""}</div>
                <div>{order.inv_addr4 || ""}</div>
              </div>
            </PanelSection>

            <PanelSection title="Notes" muted>
              <FieldRow label="Remark 2">{order.remark2 || "—"}</FieldRow>
              <FieldRow label="Remark 3">{order.remark3 || "—"}</FieldRow>
              <FieldRow label="Note">{order.note || "—"}</FieldRow>
            </PanelSection>

            {isEast && (
              <>
                <PanelSection title="Transporter">
                  <InlineEdit
                    label="ETA Port"
                    value={details?.eta_port}
                    onSave={(v) => patchDetails(order.doc_no, { eta_port: v })}
                  />
                  <InlineEdit
                    label="Estimate Delivery"
                    value={details?.estimate_delivery}
                    onSave={(v) => patchDetails(order.doc_no, { estimate_delivery: v })}
                  />
                  <InlineEdit
                    label="Vessel / Voyage"
                    value={details?.vessel_voyage}
                    onSave={(v) => patchDetails(order.doc_no, { vessel_voyage: v })}
                  />
                  <InlineEdit
                    label="ETD Port Klang"
                    value={details?.etd_port_klang}
                    onSave={(v) => patchDetails(order.doc_no, { etd_port_klang: v })}
                  />
                  <InlineEdit
                    label="ETA Destination"
                    value={details?.eta_destination}
                    onSave={(v) => patchDetails(order.doc_no, { eta_destination: v })}
                  />
                  <InlineEdit
                    label="Remarks"
                    textarea
                    value={details?.transporter_remarks}
                    onSave={(v) => patchDetails(order.doc_no, { transporter_remarks: v })}
                  />
                </PanelSection>

                <PanelSection title="Financials">
                  <InlineEdit
                    label="Seafreight"
                    type="number"
                    value={details?.seafreight}
                    onSave={(v) => patchDetails(order.doc_no, { seafreight: v ? Number(v) : null })}
                  />
                  <InlineEdit
                    label="Local Charges"
                    type="number"
                    value={details?.local_charges}
                    onSave={(v) =>
                      patchDetails(order.doc_no, { local_charges: v ? Number(v) : null })
                    }
                  />
                  <InlineEdit
                    label="Inland"
                    type="number"
                    value={details?.inland}
                    onSave={(v) => patchDetails(order.doc_no, { inland: v ? Number(v) : null })}
                  />
                  <InlineEdit
                    label="Agent Fee"
                    type="number"
                    value={details?.agent_fee}
                    onSave={(v) => patchDetails(order.doc_no, { agent_fee: v ? Number(v) : null })}
                  />
                  <InlineEdit
                    label="Insurance"
                    type="number"
                    value={details?.insurance}
                    onSave={(v) => patchDetails(order.doc_no, { insurance: v ? Number(v) : null })}
                  />
                  <InlineEdit
                    label="Total Cost"
                    type="number"
                    value={details?.total_cost}
                    onSave={(v) => patchDetails(order.doc_no, { total_cost: v ? Number(v) : null })}
                  />
                </PanelSection>
              </>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
