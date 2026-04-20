import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ExternalLink, ArrowLeft } from "lucide-react";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { PageHeader } from "../components/Layout";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatCurrency, formatDate } from "../lib/utils";
import type { Creditor } from "../types";

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

/**
 * Dedicated page for a single creditor — replaces the old side panel.
 * Linked from the Creditors tab inside Purchase Orders, and from the
 * "Creditor" link on every PO detail page.
 */
export function CreditorDetail() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<CreditorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAllFields, setShowAllFields] = useState(false);

  useEffect(() => {
    if (!code) return;
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
    <div>
      <Breadcrumbs
        items={[
          { label: "Purchase Orders", to: "/po" },
          { label: "Creditors", to: "/po?view=creditors" },
          { label: data?.creditor.company_name || code },
        ]}
      />

      <PageHeader
        eyebrow={`Creditor · ${code}${data?.creditor.currency_code ? ` · ${data.creditor.currency_code}` : ""}`}
        title={data?.creditor.company_name || code}
        description="AutoCount mirror — read-only. Header fields, contact details, recent POs."
        actions={
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
          >
            <ArrowLeft size={13} /> Back
          </button>
        }
      />

      {loading && <div className="text-[12px] text-ink-muted">Loading…</div>}

      {data && (
        <div className="space-y-6">
          <Section title="Summary">
            <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
              <Stat label="POs" value={data.po_stats.total.toLocaleString()} />
              <Stat label="Open" value={data.po_stats.open_count.toLocaleString()} />
              <Stat
                label="Spend (ex-tax)"
                value={formatCurrency(data.po_stats.total_spend, { compact: true })}
              />
              <Stat label="Currency" value={data.creditor.currency_code || "—"} />
            </div>
          </Section>

          <Section title="Contact">
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
          </Section>

          <Section title="Tax & Terms">
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
          </Section>

          <Section title={`Recent Purchase Orders (${data.recent_pos.length})`}>
            {data.recent_pos.length === 0 ? (
              <div className="text-[12px] text-ink-muted">No POs from this creditor.</div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border bg-surface">
                <table className="w-full text-[11px]">
                  <thead className="bg-bg/60 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">PO No</th>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Ref</th>
                      <th className="px-3 py-2 text-left">Status</th>
                      <th className="px-3 py-2 text-right">Cost (ex-tax)</th>
                      <th className="px-3 py-2"></th>
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
                          <td className="px-3 py-1.5 font-mono">{p.doc_no}</td>
                          <td className="px-3 py-1.5">{formatDate(p.doc_date)}</td>
                          <td className="px-3 py-1.5 text-ink-muted">{p.ref || "—"}</td>
                          <td className="px-3 py-1.5">{status}</td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {formatCurrency(p.local_ex_tax)}
                          </td>
                          <td className="px-3 py-1.5">
                            <Link
                              to={`/po?focus=${encodeURIComponent(p.doc_no)}`}
                              className="text-ink-muted hover:text-accent"
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
          </Section>

          <Section title="All Header Fields">
            <button
              onClick={() => setShowAllFields((s) => !s)}
              className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent hover:underline"
            >
              {showAllFields ? "Hide" : "Show"} all fields ({Object.keys(headerFields).length})
            </button>
            {showAllFields && <FieldGrid fields={headerFields} />}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface p-5 shadow-stone">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-px w-5 bg-accent" />
        <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </div>
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
          <dt className="min-w-[140px] truncate font-mono text-[10px] text-ink-muted">
            {k}
          </dt>
          <dd className="flex-1 truncate font-mono text-[11px] text-ink">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
