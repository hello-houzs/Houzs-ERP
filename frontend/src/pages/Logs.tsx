import { useState } from "react";
import { PageHeader } from "../components/Layout";
import { DataTable, type Column } from "../components/DataTable";
import { StatusDot } from "../components/StatusDot";
import { Pagination } from "../components/Pagination";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { api, buildQuery } from "../api/client";
import { relativeTime } from "../lib/utils";
import type { Paginated, ExecutionLog } from "../types";

export function Logs() {
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:logs", 50);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<Paginated<ExecutionLog>>(
    () =>
      api.get(
        `/api/logs${buildQuery({ type, status, page, per_page: perPage, ...sortParams })}`
      ),
    [type, status, page, perPage, sort?.key, sort?.dir]
  );

  const columns: Column<ExecutionLog>[] = [
    {
      key: "started_at",
      label: "Time",
      alwaysVisible: true,
      render: (r) => (
        <span title={r.started_at} className="font-mono text-xs text-ink-secondary">
          {relativeTime(r.started_at)}
        </span>
      ),
      getValue: (r) => r.started_at,
    },
    {
      key: "type",
      label: "Type",
      render: (r) => (
        <span className="rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-secondary">
          {r.type}
        </span>
      ),
      getValue: (r) => r.type,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <StatusDot
          variant={
            r.status === "SYNCED" ? "synced" : r.status === "FAILED" ? "error" : "neutral"
          }
          label={r.status}
        />
      ),
      getValue: (r) => r.status,
    },
    {
      key: "message",
      label: "Message",
      render: (r) => <span className="text-ink-secondary">{r.message || "—"}</span>,
      getValue: (r) => r.message,
    },
    {
      key: "request_id",
      label: "ID",
      render: (r) => (
        <span className="font-mono text-[10px] text-ink-muted" title={r.request_id}>
          {r.request_id.slice(0, 8)}
        </span>
      ),
      getValue: (r) => r.request_id,
    },
  ];

  const selectClass =
    "h-9 rounded-lg border border-border bg-surface px-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/15";

  return (
    <div>
      <PageHeader
        eyebrow="System · Audit"
        title="Activity Log"
        description="System execution history"
        actions={
          <>
            <select
              className={selectClass}
              value={type}
              onChange={(e) => {
                setPage(1);
                setType(e.target.value);
              }}
            >
              <option value="">All Types</option>
              <option value="PULL">Pull</option>
              <option value="PUSH">Push</option>
              <option value="OVERDUE">Overdue</option>
              <option value="PO">PO</option>
              <option value="ASSR">ASSR</option>
            </select>
            <select
              className={selectClass}
              value={status}
              onChange={(e) => {
                setPage(1);
                setStatus(e.target.value);
              }}
            >
              <option value="">All Status</option>
              <option value="SYNCED">Synced</option>
              <option value="FAILED">Failed</option>
              <option value="SKIPPED">Skipped</option>
            </select>
          </>
        }
      />

      <DataTable
        tableId="logs"
        udfTable="logs"
        udfTableLabel="Activity Log"
        exportName="activity-log"
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No log entries"
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
