import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection } from "../components/Panel";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import type { Paginated, Creditor, CreditorSummary } from "../types";

/**
 * CreditorsTab — embeds inside the PurchaseOrders page as one tab.
 * Read-only mirror of AutoCount /Creditor/getAll. Distinct from
 * /suppliers (local service/3PL suppliers). The parent page owns the
 * Refresh button and triggers reload via the `refreshKey` prop.
 *
 * `focus` is read from the URL `?focus=<creditor_code>` — when set
 * the side panel opens for that creditor.
 */

export function CreditorsTab({ refreshKey = 0 }: { refreshKey?: number }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:creditors", 50);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));
  const [params, setParams] = useSearchParams();
  const focus = params.get("focus");

  const list = useQuery<Paginated<Creditor>>(
    () =>
      api.get(
        `/api/creditors${buildQuery({
          search,
          page,
          per_page: perPage,
          ...sortParams,
        })}`
      ),
    [search, page, perPage, sort?.key, sort?.dir, refreshKey]
  );

  const summary = useQuery<CreditorSummary>(
    () => api.get("/api/creditors/summary"),
    [refreshKey]
  );

  const columns: Column<Creditor>[] = [
    {
      key: "creditor_code",
      label: "Code",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.creditor_code}</span>,
      getValue: (r) => r.creditor_code,
    },
    {
      key: "company_name",
      label: "Name",
      alwaysVisible: true,
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{r.company_name || "—"}</div>
          {r.desc2 && r.desc2 !== r.company_name && (
            <div className="text-[11px] text-ink-muted">{r.desc2}</div>
          )}
        </div>
      ),
      getValue: (r) => r.company_name,
    },
    {
      key: "contact",
      label: "Contact",
      render: (r) => (
        <div className="text-xs">
          {r.email && <div>{r.email}</div>}
          {r.phone1 && <div className="text-ink-muted">{r.phone1}</div>}
          {!r.email && !r.phone1 && <span className="text-ink-muted">—</span>}
        </div>
      ),
      getValue: (r) => `${r.email || ""} ${r.phone1 || ""}`.trim(),
    },
    {
      key: "currency",
      label: "Curr",
      render: (r) => <span className="text-xs">{r.currency_code || "—"}</span>,
      getValue: (r) => r.currency_code,
    },
    {
      key: "po_count",
      label: "POs",
      align: "right",
      render: (r) => (
        <span className="font-mono text-xs">
          {(r.po_count ?? 0).toLocaleString()}
          {(r.open_po_count ?? 0) > 0 && (
            <span className="ml-1 text-amber-700">({r.open_po_count} open)</span>
          )}
        </span>
      ),
      getValue: (r) => r.po_count ?? 0,
    },
    {
      key: "total_spend",
      label: "Spend (RM)",
      align: "right",
      render: (r) => (
        <span className="font-mono text-xs font-semibold">
          {formatCurrency(r.total_local_ex_tax ?? 0, { compact: true })}
        </span>
      ),
      getValue: (r) => r.total_local_ex_tax ?? 0,
    },
    {
      key: "type",
      label: "Type",
      render: (r) => <span className="text-xs">{r.type_description || r.type || "—"}</span>,
      getValue: (r) => r.type_description || r.type,
    },
    {
      key: "purchase_agent",
      label: "Agent",
      render: (r) => (
        <span className="text-xs">
          {r.purchase_agent_description || r.purchase_agent || "—"}
        </span>
      ),
      getValue: (r) => r.purchase_agent_description || r.purchase_agent,
    },
  ];

  return (
    <div>
      {(() => {
        const s = summary.data;
        return (
          <>
            <DashboardGrid cols={3}>
              <StatCard
                label="Total Creditors"
                value={s ? s.totals.total.toLocaleString() : "—"}
                subtitle="Mirrored from AutoCount"
              />
              <StatCard
                label="Currencies"
                value={s ? s.totals.currency_count.toLocaleString() : "—"}
                subtitle={s ? `${s.totals.type_count} types` : "Loading…"}
              />
              <StatCard
                label="Top Spend"
                value={
                  s && s.top_by_spend[0]
                    ? formatCurrency(s.top_by_spend[0].total_spend, { compact: true })
                    : "—"
                }
                subtitle={
                  s && s.top_by_spend[0] ? s.top_by_spend[0].creditor_name : "Loading…"
                }
              />
            </DashboardGrid>

            <DashboardPanels cols={1}>
              <DashboardBreakdown
                title="Top Creditors by Spend"
                items={
                  s?.top_by_spend.map((t) => ({
                    label: t.creditor_name,
                    count: t.po_count,
                  })) ?? []
                }
              />
            </DashboardPanels>
          </>
        );
      })()}

      <DataTable
        tableId="creditors"
        exportName="creditors"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search code, name, email, phone…",
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No creditors yet — hit Refresh to pull from AutoCount"
        getRowKey={(r) => r.creditor_code}
        onRowClick={(r) => {
          const next = new URLSearchParams(params);
          next.set("focus", r.creditor_code);
          setParams(next, { replace: true });
        }}
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

      {focus && (
        <CreditorPanel
          code={focus}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete("focus");
            setParams(next, { replace: true });
          }}
        />
      )}
    </div>
  );
}

// ── Creditor side panel ──────────────────────────────────────

interface CreditorDetail {
  creditor: Creditor;
  po_stats: {
    total: number;
    open_count: number;
    closed_count: number;
    cancelled_count: number;
    total_spend: number;
  };
  recent_pos: Array<{
    doc_no: string;
    doc_date: string | null;
    ref: string | null;
    doc_status: string | null;
    cancelled: number;
    local_ex_tax: number | null;
    final_total: number | null;
  }>;
}

function CreditorPanel({ code, onClose }: { code: string; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<CreditorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAllFields, setShowAllFields] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<CreditorDetail>(`/api/creditors/${encodeURIComponent(code)}`)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: any) => toast.error(`Failed to load: ${e?.message || e}`))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const headerFields = useMemo<Record<string, unknown>>(() => {
    if (!data?.creditor.raw) return {};
    try {
      return JSON.parse(data.creditor.raw);
    } catch {
      return {};
    }
  }, [data?.creditor.raw]);

  return (
    <Panel
      open
      onClose={onClose}
      title={data?.creditor.company_name || code}
      subtitle={`${code}${data?.creditor.currency_code ? ` · ${data.creditor.currency_code}` : ""}`}
      width={680}
    >
      {loading && <div className="text-[12px] text-ink-muted">Loading…</div>}
      {data && (
        <>
          <PanelSection title="Summary">
            <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
              <Stat
                label="POs"
                value={data.po_stats.total.toLocaleString()}
              />
              <Stat
                label="Open"
                value={data.po_stats.open_count.toLocaleString()}
              />
              <Stat
                label="Spend (ex-tax)"
                value={formatCurrency(data.po_stats.total_spend, { compact: true })}
              />
              <Stat
                label="Currency"
                value={data.creditor.currency_code || "—"}
              />
            </div>
          </PanelSection>

          <PanelSection title="Contact">
            <FieldGrid
              fields={{
                Email: data.creditor.email,
                Phone1: data.creditor.phone1,
                Phone2: data.creditor.phone2,
                Mobile: data.creditor.mobile,
                Fax: data.creditor.fax1,
                Web: data.creditor.web_url,
                Attention: data.creditor.attention,
                Address: [
                  data.creditor.address1,
                  data.creditor.address2,
                  data.creditor.address3,
                  data.creditor.address4,
                  data.creditor.post_code,
                ]
                  .filter(Boolean)
                  .join(", "),
              }}
            />
          </PanelSection>

          <PanelSection title="Tax & Terms">
            <FieldGrid
              fields={{
                "Tax Code": data.creditor.tax_code,
                "Tax Register No": data.creditor.tax_register_no,
                "GST Register No": data.creditor.gst_register_no,
                "SST Register No": data.creditor.sst_register_no,
                "Credit Limit": data.creditor.credit_limit
                  ? formatCurrency(data.creditor.credit_limit)
                  : null,
                "Overdue Limit": data.creditor.overdue_limit
                  ? formatCurrency(data.creditor.overdue_limit)
                  : null,
                "Display Term": data.creditor.display_term,
                "Purchase Agent": data.creditor.purchase_agent,
                Type: data.creditor.type_description || data.creditor.type,
                Area: data.creditor.area_description || data.creditor.area_code,
              }}
            />
          </PanelSection>

          <PanelSection title={`Recent Purchase Orders (${data.recent_pos.length})`}>
            {data.recent_pos.length === 0 ? (
              <div className="text-[12px] text-ink-muted">No POs from this creditor.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-bg/60 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                    <tr>
                      <th className="px-2 py-2 text-left">PO No</th>
                      <th className="px-2 py-2 text-left">Date</th>
                      <th className="px-2 py-2 text-left">Ref</th>
                      <th className="px-2 py-2 text-left">Status</th>
                      <th className="px-2 py-2 text-right">Cost (ex-tax)</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_pos.map((p) => {
                      const status = p.cancelled
                        ? "Cancelled"
                        : (p.doc_status || "").toUpperCase() === "C"
                        ? "Closed"
                        : "Open";
                      return (
                        <tr key={p.doc_no} className="border-t border-border-subtle">
                          <td className="px-2 py-1.5 font-mono">{p.doc_no}</td>
                          <td className="px-2 py-1.5">{formatDate(p.doc_date)}</td>
                          <td className="px-2 py-1.5 text-ink-muted">{p.ref || "—"}</td>
                          <td className="px-2 py-1.5">{status}</td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {formatCurrency(p.local_ex_tax)}
                          </td>
                          <td className="px-2 py-1.5">
                            <Link
                              to={`/po?focus=${encodeURIComponent(p.doc_no)}`}
                              className="text-ink-muted hover:text-accent"
                              onClick={onClose}
                              title="Open PO"
                            >
                              <ExternalLink size={11} />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </PanelSection>

          <PanelSection title="All Header Fields">
            <button
              onClick={() => setShowAllFields((s) => !s)}
              className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent hover:underline"
            >
              {showAllFields ? "Hide" : "Show"} all fields ({Object.keys(headerFields).length})
            </button>
            {showAllFields && <FieldGrid fields={headerFields} />}
          </PanelSection>
        </>
      )}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
      <div className="font-mono text-[12.5px] font-bold text-ink">{value}</div>
    </div>
  );
}

function FieldGrid({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );
  if (entries.length === 0) {
    return <div className="text-[11px] text-ink-muted">—</div>;
  }
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {entries.map(([k, v]) => (
        <div
          key={k}
          className="flex items-baseline gap-2 border-b border-border-subtle/60 py-0.5"
        >
          <dt className="min-w-[140px] truncate font-mono text-[10px] text-ink-muted">{k}</dt>
          <dd className="flex-1 truncate font-mono text-[11px] text-ink">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
