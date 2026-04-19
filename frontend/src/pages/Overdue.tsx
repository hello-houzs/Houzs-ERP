import { useState } from "react";
import { Play } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, relativeTime } from "../lib/utils";
import type { Paginated, OverdueHistoryRow, OverdueSummary } from "../types";

export function Overdue() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:overdue", 50);
  const [running, setRunning] = useState(false);

  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<Paginated<OverdueHistoryRow>>(
    () =>
      api.get(
        `/api/overdue/history${buildQuery({ page, per_page: perPage, ...sortParams })}`
      ),
    [page, perPage, sort?.key, sort?.dir]
  );

  const summary = useQuery<OverdueSummary>(() => api.get("/api/overdue/summary"));

  async function runCheck() {
    setRunning(true);
    try {
      const res: any = await api.post("/api/overdue/run");
      toast.success(res?.message || "Overdue check complete");
      list.reload();
      summary.reload();
    } catch (e: any) {
      toast.error(`Failed: ${e?.message || e}`);
    } finally {
      setRunning(false);
    }
  }

  const columns: Column<OverdueHistoryRow>[] = [
    {
      key: "pull_date",
      label: "Date",
      alwaysVisible: true,
      render: (r) => (
        <span className="font-mono text-xs">{r.pull_date.slice(0, 16).replace("T", " ")}</span>
      ),
      getValue: (r) => r.pull_date,
    },
    {
      key: "doc_no",
      label: "Doc No",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.doc_no}</span>,
      getValue: (r) => r.doc_no,
    },
    {
      key: "debtor_name",
      label: "Customer",
      render: (r) => r.debtor_name || "—",
      getValue: (r) => r.debtor_name,
    },
    {
      key: "location",
      label: "Location",
      render: (r) => r.location || "—",
      getValue: (r) => r.location,
    },
    {
      key: "balance",
      label: "Balance",
      align: "right",
      render: (r) => <span className="font-mono text-xs">{formatCurrency(r.balance)}</span>,
      getValue: (r) => r.balance,
    },
    {
      key: "original_expiry_date",
      label: "Was Expiring",
      render: (r) => formatDate(r.original_expiry_date),
      getValue: (r) => formatDate(r.original_expiry_date),
    },
    {
      key: "extended_to",
      label: "Extended To",
      render: (r) => formatDate(r.extended_to),
      getValue: (r) => formatDate(r.extended_to),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Finance · Audit"
        title="Overdue History"
        description="Auto-extended orders log (runs daily at 02:00)"
        actions={
          <Button icon={<Play size={14} />} onClick={runCheck} disabled={running}>
            {running ? "Running…" : "Run Check"}
          </Button>
        }
      />

      {(() => {
        const s = summary.data;
        return (
          <>
            <DashboardGrid cols={4}>
              <StatCard
                label="Auto-Extended (All Time)"
                value={s ? s.totals.count.toLocaleString() : "—"}
                subtitle={s ? `${formatCurrency(s.totals.total, { compact: true })} total` : " "}
              />
              <StatCard
                label="Last 30 Days"
                value={s ? s.recent_30d.toLocaleString() : "—"}
                subtitle="Recent extensions"
              />
              <StatCard
                label="Last Run"
                value={s?.last_pull ? relativeTime(s.last_pull) : "Never"}
                subtitle={s?.last_pull ? new Date(s.last_pull).toISOString().slice(0, 10) : " "}
              />
              <StatCard
                label="Schedule"
                value="02:00 daily"
                subtitle="Cron auto-extends overdue"
              />
            </DashboardGrid>

            <DashboardPanels cols={1}>
              <DashboardBreakdown
                title="By Location (Top 5 by Total Balance)"
                items={
                  s?.by_location.map((l) => ({
                    label: l.location,
                    count: Math.round(l.total),
                  })) ?? []
                }
                formatCount={(n) => formatCurrency(n, { compact: true })}
              />
            </DashboardPanels>
          </>
        );
      })()}

      <DataTable
        tableId="overdue"
        udfTable="overdue"
        udfTableLabel="Overdue History"
        exportName="overdue-history"
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No overdue history"
        getRowKey={(r) => r.id}
        serverSort
        onSortChange={handleSortChange}
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
