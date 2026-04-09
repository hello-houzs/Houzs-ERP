import { useState } from "react";
import { Plus } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { DataTable, type Column } from "../components/DataTable";
import { StatusDot, statusVariantForAssr } from "../components/StatusDot";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection } from "../components/Panel";
import { InlineEdit } from "../components/InlineEdit";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { formatDate } from "../lib/utils";
import type { Paginated, AssrCase, AssrSummary } from "../types";

type StatusFilter = "ALL" | "Open" | "In Progress" | "Closed";

export function ServiceCases() {
  const toast = useToast();
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:assr", 50);
  const [selected, setSelected] = useState<AssrCase | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ doc_no: "", item_code: "", complaint_issue: "" });
  const [submitting, setSubmitting] = useState(false);

  const list = useQuery<Paginated<AssrCase>>(
    () =>
      api.get(
        `/api/assr${buildQuery({
          status: status === "ALL" ? undefined : status,
          search,
          page,
          per_page: perPage,
        })}`
      ),
    [status, search, page, perPage]
  );

  const summary = useQuery<AssrSummary>(() => api.get("/api/assr/summary"));

  async function submitNew() {
    if (!form.doc_no || !form.item_code || !form.complaint_issue) {
      toast.error("All fields required");
      return;
    }
    setSubmitting(true);
    try {
      const res: any = await api.post("/api/assr", form);
      toast.success(`Case created: ${res.assr_no}`);
      setCreating(false);
      setForm({ doc_no: "", item_code: "", complaint_issue: "" });
      list.reload();
    } catch (e: any) {
      toast.error(`Create failed: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function patchCase(assrNo: string, body: Record<string, any>) {
    try {
      await api.patch(`/api/assr/${encodeURIComponent(assrNo)}`, body);
      list.reload();
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message || e}`);
    }
  }

  const columns: Column<AssrCase>[] = [
    {
      key: "assr_no",
      label: "ASSR No",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-semibold">{r.assr_no}</span>,
      getValue: (r) => r.assr_no,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusDot variant={statusVariantForAssr(r.status)} label={r.status} />,
      getValue: (r) => r.status,
    },
    {
      key: "doc_no",
      label: "SO No",
      render: (r) => <span className="font-mono text-xs">{r.doc_no}</span>,
      getValue: (r) => r.doc_no,
    },
    {
      key: "complained_date",
      label: "Date",
      render: (r) => formatDate(r.complained_date),
      getValue: (r) => formatDate(r.complained_date),
    },
    {
      key: "customer_name",
      label: "Customer",
      render: (r) => r.customer_name || "—",
      getValue: (r) => r.customer_name,
    },
    {
      key: "item_code",
      label: "Item",
      render: (r) => <span className="font-mono text-xs">{r.item_code || "—"}</span>,
      getValue: (r) => r.item_code,
    },
    {
      key: "complaint_issue",
      label: "Issue",
      render: (r) => (
        <span className="block max-w-[260px] truncate text-ink-secondary">
          {r.complaint_issue || "—"}
        </span>
      ),
      getValue: (r) => r.complaint_issue,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Aftersales · Service"
        title="Service Cases"
        description="ASSR complaint tracking"
        actions={
          <Button icon={<Plus size={14} />} onClick={() => setCreating(true)}>
            New Case
          </Button>
        }
      />

      {(() => {
        const s = summary.data;
        const open = s?.by_status.find((x) => x.status === "Open")?.count ?? 0;
        const inProgress = s?.by_status.find((x) => x.status === "In Progress")?.count ?? 0;
        const closed = s?.by_status.find((x) => x.status === "Closed")?.count ?? 0;
        return (
          <>
            <DashboardGrid cols={4}>
              <StatCard
                label="Total Cases"
                value={s ? s.total.toLocaleString() : "—"}
                subtitle={s ? `${s.recent_30d} new in last 30 days` : " "}
              />
              <StatCard
                label="Open"
                value={s ? open.toLocaleString() : "—"}
                subtitle="Awaiting action"
                tone={open > 0 ? "error" : "default"}
              />
              <StatCard
                label="In Progress"
                value={s ? inProgress.toLocaleString() : "—"}
                subtitle="Being worked on"
              />
              <StatCard
                label="Closed"
                value={s ? closed.toLocaleString() : "—"}
                subtitle="Resolved"
                tone={s ? "success" : "default"}
              />
            </DashboardGrid>

            <DashboardPanels cols={2}>
              <DashboardBreakdown
                title="Top Locations"
                items={
                  s?.by_location.map((l) => ({ label: l.location, count: l.count })) ?? []
                }
              />
              <DashboardBreakdown
                title="By Service Category"
                items={s?.by_category.map((c) => ({ label: c.name, count: c.count })) ?? []}
              />
            </DashboardPanels>
          </>
        );
      })()}

      <div className="mb-4">
        <FilterPills
          value={status}
          onChange={(v) => {
            setPage(1);
            setStatus(v);
          }}
          options={[
            { value: "ALL", label: "All" },
            { value: "Open", label: "Open" },
            { value: "In Progress", label: "In Progress" },
            { value: "Closed", label: "Closed" },
          ]}
        />
      </div>

      <DataTable
        tableId="assr"
        udfTable="assr"
        udfTableLabel="Service Cases"
        exportName="service-cases"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search ASSR, SO, customer…",
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No service cases"
        getRowKey={(r) => r.id}
        onRowClick={(r) => setSelected(r)}
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
        open={creating}
        onClose={() => setCreating(false)}
        title="New Service Case"
        subtitle="An ASSR number will be generated automatically"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={submitNew} disabled={submitting}>
              {submitting ? "Creating…" : "Create Case"}
            </Button>
          </div>
        }
      >
        <PanelSection title="Required">
          <div>
            <label className="mb-1 block text-xs text-ink-muted">Doc No (SO)</label>
            <input
              value={form.doc_no}
              onChange={(e) => setForm({ ...form, doc_no: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">Item Code</label>
            <input
              value={form.item_code}
              onChange={(e) => setForm({ ...form, item_code: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">Issue Description</label>
            <textarea
              value={form.complaint_issue}
              onChange={(e) => setForm({ ...form, complaint_issue: e.target.value })}
              className="min-h-[100px] w-full resize-y rounded-md border border-border bg-surface p-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
          </div>
        </PanelSection>
      </Panel>

      <Panel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.assr_no || ""}
        subtitle={selected?.customer_name || ""}
      >
        {selected && (
          <>
            <PanelSection title="Case">
              <InlineEdit
                label="Status"
                value={selected.status}
                onSave={(v) => patchCase(selected.assr_no, { status: v })}
              />
              <InlineEdit
                label="Customer"
                value={selected.customer_name}
                onSave={(v) => patchCase(selected.assr_no, { customer_name: v })}
              />
              <InlineEdit
                label="Phone"
                value={selected.phone}
                onSave={(v) => patchCase(selected.assr_no, { phone: v })}
              />
              <InlineEdit
                label="Location"
                value={selected.location}
                onSave={(v) => patchCase(selected.assr_no, { location: v })}
              />
              <InlineEdit
                label="Sales Agent"
                value={selected.sales_agent}
                onSave={(v) => patchCase(selected.assr_no, { sales_agent: v })}
              />
              <InlineEdit
                label="Item Code"
                value={selected.item_code}
                onSave={(v) => patchCase(selected.assr_no, { item_code: v })}
              />
            </PanelSection>

            <PanelSection title="Issue">
              <InlineEdit
                label="Complaint"
                textarea
                value={selected.complaint_issue}
                onSave={(v) => patchCase(selected.assr_no, { complaint_issue: v })}
              />
              <InlineEdit
                label="Action Remark"
                textarea
                value={selected.action_remark}
                onSave={(v) => patchCase(selected.assr_no, { action_remark: v })}
              />
              <InlineEdit
                label="Service Category"
                value={selected.service_category}
                onSave={(v) => patchCase(selected.assr_no, { service_category: v })}
              />
              <InlineEdit
                label="Supplier"
                value={selected.supplier}
                onSave={(v) => patchCase(selected.assr_no, { supplier: v })}
              />
              <InlineEdit
                label="Completion Date"
                type="date"
                value={selected.completion_date}
                onSave={(v) => patchCase(selected.assr_no, { completion_date: v })}
              />
              <InlineEdit
                label="PO No"
                value={selected.po_no}
                onSave={(v) => patchCase(selected.assr_no, { po_no: v })}
              />
            </PanelSection>
          </>
        )}
      </Panel>
    </div>
  );
}
