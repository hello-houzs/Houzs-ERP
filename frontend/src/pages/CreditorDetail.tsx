import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
  StatStrip,
  DefinitionList,
} from "../components/DetailLayout";
import { DataTable, type Column } from "../components/DataTable";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatCurrency, formatDate } from "../lib/utils";
import type { Creditor } from "../types";

type RecentPo = CreditorDetailData["recent_pos"][number];

function poStatusLabel(p: RecentPo): string {
  return p.cancelled
    ? "Cancelled"
    : (p.doc_status || "").toUpperCase() === "C"
    ? "Closed"
    : "Open";
}

const PO_COLUMNS: Column<RecentPo>[] = [
  {
    key: "doc_no",
    label: "PO No",
    getValue: (p) => p.doc_no,
    render: (p) => (
      <Link
        to={`/po/${encodeURIComponent(p.doc_no)}`}
        className="font-mono font-medium hover:text-accent"
      >
        {p.doc_no}
      </Link>
    ),
  },
  {
    key: "doc_date",
    label: "Date",
    getValue: (p) => p.doc_date || "",
    render: (p) => (
      <span className="font-mono text-[11px] text-ink-secondary">
        {formatDate(p.doc_date)}
      </span>
    ),
  },
  {
    key: "ref",
    label: "Ref",
    getValue: (p) => p.ref || "",
    render: (p) => <span className="text-ink-muted">{p.ref || "—"}</span>,
  },
  {
    key: "status",
    label: "Status",
    getValue: (p) => poStatusLabel(p),
    render: (p) => <StatusPill status={poStatusLabel(p)} />,
  },
  {
    key: "local_ex_tax",
    label: "Cost (ex-tax)",
    align: "right",
    getValue: (p) => p.local_ex_tax ?? 0,
    render: (p) => (
      <span className="font-mono">{formatCurrency(p.local_ex_tax)}</span>
    ),
  },
];

interface CreditorDetailData {
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

/**
 * Dedicated page for a single creditor — replaces the old side panel.
 * Linked from the Creditors tab inside Purchase Orders, and from the
 * "Creditor" link on every PO detail page.
 */
export function CreditorDetail() {
  const { code = "" } = useParams<{ code: string }>();
  const toast = useToast();
  const [data, setData] = useState<CreditorDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllFields, setShowAllFields] = useState(false);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<CreditorDetailData>(`/api/creditors/${encodeURIComponent(code)}`)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: any) => {
        if (cancelled) return;
        const msg = e?.message || String(e);
        setError(msg);
        toast.error(`Failed to load: ${msg}`);
      })
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

  const c = data?.creditor;

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Purchase Orders", to: "/po" },
        { label: "Creditors", to: "/po?view=creditors" },
        { label: c?.company_name || code },
      ]}
      eyebrow={`Creditor · ${code}${c?.currency_code ? ` · ${c.currency_code}` : ""}`}
      title={c?.company_name || code}
      description={c?.desc2 && c.desc2 !== c.company_name ? c.desc2 : undefined}
      backTo="/po?view=creditors"
      loading={loading && !data}
      error={error}
    >
      {data && (
        <>
          <StatStrip
            items={[
              { label: "Total POs", value: data.po_stats.total.toLocaleString() },
              {
                label: "Open",
                value: data.po_stats.open_count.toLocaleString(),
                tone: data.po_stats.open_count > 0 ? "warn" : "default",
              },
              {
                label: "Spend (ex-tax)",
                value: formatCurrency(data.po_stats.total_spend, { compact: true }),
              },
              {
                label: "Currency",
                value: c?.currency_code || "—",
              },
            ]}
          />

          <div className="mt-5">
            <DetailGrid>
              <DetailMain>
                <DataTable
                  tableId="creditor-recent-pos"
                  caption="Recent Purchase Orders"
                  columns={PO_COLUMNS}
                  rows={data.recent_pos}
                  getRowKey={(p) => p.doc_no}
                  emptyLabel="No POs from this creditor."
                  exportName={`creditor-${code}-pos`}
                />

                <Section
                  title={`All Header Fields (${Object.keys(headerFields).length})`}
                  actions={
                    <button
                      onClick={() => setShowAllFields((s) => !s)}
                      className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
                    >
                      {showAllFields ? (
                        <>
                          <ChevronUp size={11} /> Hide
                        </>
                      ) : (
                        <>
                          <ChevronDown size={11} /> Show
                        </>
                      )}
                    </button>
                  }
                >
                  {showAllFields ? (
                    <DefinitionList
                      items={Object.entries(headerFields).map(([k, v]) => ({
                        label: k,
                        mono: true,
                        value:
                          typeof v === "object"
                            ? JSON.stringify(v)
                            : v != null
                            ? String(v)
                            : null,
                      }))}
                    />
                  ) : (
                    <div className="text-[11.5px] text-ink-muted">
                      Tap “Show” to expand the full AutoCount payload — useful for
                      debugging upstream field changes.
                    </div>
                  )}
                </Section>
              </DetailMain>

              <DetailAside>
                <Section title="Contact">
                  <DefinitionList
                    items={[
                      { label: "Email", value: c?.email },
                      { label: "Phone 1", value: c?.phone1, mono: true },
                      { label: "Phone 2", value: c?.phone2, mono: true },
                      { label: "Mobile", value: c?.mobile, mono: true },
                      { label: "Fax", value: c?.fax1, mono: true },
                      { label: "Web", value: c?.web_url },
                      { label: "Attention", value: c?.attention },
                      {
                        label: "Address",
                        full: true,
                        value: [
                          c?.address1,
                          c?.address2,
                          c?.address3,
                          c?.address4,
                          c?.post_code,
                        ]
                          .filter(Boolean)
                          .join(", "),
                      },
                    ]}
                  />
                </Section>

                <Section title="Tax & Terms">
                  <DefinitionList
                    items={[
                      { label: "Tax Code", value: c?.tax_code, mono: true },
                      {
                        label: "Tax Reg No",
                        value: c?.tax_register_no,
                        mono: true,
                      },
                      {
                        label: "GST Reg",
                        value: c?.gst_register_no,
                        mono: true,
                      },
                      {
                        label: "SST Reg",
                        value: c?.sst_register_no,
                        mono: true,
                      },
                      {
                        label: "Credit Limit",
                        value: c?.credit_limit
                          ? formatCurrency(c.credit_limit)
                          : null,
                        mono: true,
                      },
                      {
                        label: "Overdue Limit",
                        value: c?.overdue_limit
                          ? formatCurrency(c.overdue_limit)
                          : null,
                        mono: true,
                      },
                      { label: "Term", value: c?.display_term },
                      { label: "Agent", value: c?.purchase_agent },
                      {
                        label: "Type",
                        value: c?.type_description || c?.type,
                      },
                      {
                        label: "Area",
                        value: c?.area_description || c?.area_code,
                      },
                    ]}
                  />
                </Section>
              </DetailAside>
            </DetailGrid>
          </div>
        </>
      )}
    </DetailLayout>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "Closed"
      ? "bg-synced/10 text-synced"
      : status === "Cancelled"
      ? "bg-ink/10 text-ink-muted"
      : "bg-warning-bg text-warning-text";
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider ${tone}`}
    >
      {status}
    </span>
  );
}
