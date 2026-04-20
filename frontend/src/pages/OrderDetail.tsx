import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { PageHeader } from "../components/Layout";
import { PanelSection, FieldRow } from "../components/Panel";
import { InlineEdit } from "../components/InlineEdit";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import type { SalesOrder, OrderDetails } from "../types";

const DELIVERY_MESSAGE_STATUSES = [
  "PENDING",
  "TO_DELIVER",
  "DELIVERED",
  "CANCELLED",
  "ON_HOLD",
];

interface OrderLinesResponse {
  lines: Array<Record<string, any>>;
}

/**
 * Dedicated detail page for a sales order. Replaces both the side
 * panel from /orders and the smaller delivery-only panel from
 * /delivery-orders. Mounted at /orders/:docNo.
 */
export function OrderDetail() {
  const { docNo: rawDocNo = "" } = useParams<{ docNo: string }>();
  const docNo = decodeURIComponent(rawDocNo);
  const navigate = useNavigate();
  const toast = useToast();

  const detail = useQuery<{ order: SalesOrder; details: OrderDetails | null }>(
    () => api.get(`/api/orders/${encodeURIComponent(docNo)}`),
    [docNo]
  );
  const lines = useQuery<OrderLinesResponse>(
    () => api.get(`/api/orders/${encodeURIComponent(docNo)}/lines`),
    [docNo]
  );

  const order = detail.data?.order ?? null;
  const details = detail.data?.details ?? null;
  const isEast = order?.region === "EAST";

  async function patchOrder(body: Record<string, any>) {
    try {
      const res: any = await api.patch(
        `/api/orders/${encodeURIComponent(docNo)}`,
        body
      );
      if (res?.sync_status === "ERROR") {
        throw new Error(res.sync_error || "Push failed");
      }
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function patchDetails(body: Record<string, any>) {
    try {
      await api.patch(`/api/orders/${encodeURIComponent(docNo)}/details`, body);
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "Sales Orders", to: "/orders" },
          { label: docNo },
        ]}
      />
      <PageHeader
        eyebrow={`Sales Order · ${docNo}`}
        title={order?.debtor_name || "Loading…"}
        description={order ? `${formatDate(order.doc_date)} · Total ${formatCurrency(order.local_total)}` : undefined}
        actions={
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
          >
            <ArrowLeft size={13} /> Back
          </button>
        }
      />

      {detail.loading && <div className="text-[12px] text-ink-muted">Loading…</div>}
      {detail.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-4 text-sm text-err">
          {detail.error}
        </div>
      )}

      {order && (
        <div className="space-y-6">
          <Section title="Order">
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
          </Section>

          <Section title={`Line Items${lines.data?.lines?.length ? ` (${lines.data.lines.length})` : ""}`}>
            {lines.loading && (
              <div className="text-[12px] text-ink-muted">Loading line items…</div>
            )}
            {lines.error && (
              <div className="text-[12px] text-err">
                Could not fetch line items: {lines.error}
              </div>
            )}
            {!lines.loading && !lines.error && (lines.data?.lines?.length ?? 0) === 0 && (
              <div className="text-[12px] text-ink-muted">No line items</div>
            )}
            {!lines.loading && (lines.data?.lines?.length ?? 0) > 0 && (
              <div className="overflow-hidden rounded border border-border">
                <table className="w-full text-[12px]">
                  <thead className="bg-bg/60">
                    <tr className="text-left text-ink-muted">
                      <th className="px-2 py-1.5 font-semibold">Item</th>
                      <th className="px-2 py-1.5 font-semibold">Description</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Price</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.data!.lines.map((ln, i) => {
                      const desc = ln.Description ?? ln.ItemDescription ?? "";
                      const qty = ln.Qty ?? null;
                      const price = ln.UnitPrice ?? null;
                      const amount = ln.Amount ?? null;
                      return (
                        <tr key={i} className="border-t border-border">
                          <td className="px-2 py-1.5 font-mono text-[11px]">
                            {ln.ItemCode || "—"}
                          </td>
                          <td className="max-w-[200px] truncate px-2 py-1.5 text-ink-secondary">
                            {desc || "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {qty != null ? qty : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {price != null ? formatCurrency(price) : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {amount != null ? formatCurrency(amount) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Delivery (auto-pushed)">
            <InlineEdit
              label="Delivery Message Status"
              value={order.remark4}
              options={DELIVERY_MESSAGE_STATUSES}
              onSave={(v) => patchOrder({ remark4: v })}
            />
            <InlineEdit
              label="Expiry Date"
              type="date"
              value={order.expiry_date}
              onSave={(v) => patchOrder({ expiry_date: v })}
            />
            <InlineEdit
              label="Delivery Date"
              type="date"
              value={details?.delivery_date}
              onSave={(v) => patchDetails({ delivery_date: v })}
            />
            <InlineEdit
              label="Time Range"
              value={details?.time_range}
              onSave={(v) => patchDetails({ time_range: v })}
            />
            <InlineEdit
              label="Driver"
              value={details?.driver_name}
              onSave={(v) => patchDetails({ driver_name: v })}
            />
            <InlineEdit
              label="Lorry Plate"
              value={details?.lorry_plate}
              onSave={(v) => patchDetails({ lorry_plate: v })}
            />
            <InlineEdit
              label="Driver Contact"
              value={details?.driver_contact}
              onSave={(v) => patchDetails({ driver_contact: v })}
            />
          </Section>

          <Section title="Address">
            <div className="space-y-1 text-sm text-ink-secondary">
              <div>{order.inv_addr1 || "—"}</div>
              <div>{order.inv_addr2 || ""}</div>
              <div>{order.inv_addr3 || ""}</div>
              <div>{order.inv_addr4 || ""}</div>
            </div>
          </Section>

          <Section title="Notes">
            <FieldRow label="Remark 2">{order.remark2 || "—"}</FieldRow>
            <FieldRow label="Remark 3">{order.remark3 || "—"}</FieldRow>
            <FieldRow label="Note">{order.note || "—"}</FieldRow>
          </Section>

          {isEast && (
            <>
              <Section title="Transporter">
                <InlineEdit
                  label="ETA Port"
                  value={details?.eta_port}
                  onSave={(v) => patchDetails({ eta_port: v })}
                />
                <InlineEdit
                  label="Estimate Delivery"
                  value={details?.estimate_delivery}
                  onSave={(v) => patchDetails({ estimate_delivery: v })}
                />
                <InlineEdit
                  label="Vessel / Voyage"
                  value={details?.vessel_voyage}
                  onSave={(v) => patchDetails({ vessel_voyage: v })}
                />
                <InlineEdit
                  label="ETD Port Klang"
                  value={details?.etd_port_klang}
                  onSave={(v) => patchDetails({ etd_port_klang: v })}
                />
                <InlineEdit
                  label="ETA Destination"
                  value={details?.eta_destination}
                  onSave={(v) => patchDetails({ eta_destination: v })}
                />
                <InlineEdit
                  label="Remarks"
                  textarea
                  value={details?.transporter_remarks}
                  onSave={(v) => patchDetails({ transporter_remarks: v })}
                />
              </Section>

              <Section title="Financials">
                <InlineEdit
                  label="Seafreight"
                  type="number"
                  value={details?.seafreight}
                  onSave={(v) =>
                    patchDetails({ seafreight: v ? Number(v) : null })
                  }
                />
                <InlineEdit
                  label="Local Charges"
                  type="number"
                  value={details?.local_charges}
                  onSave={(v) =>
                    patchDetails({ local_charges: v ? Number(v) : null })
                  }
                />
                <InlineEdit
                  label="Inland"
                  type="number"
                  value={details?.inland}
                  onSave={(v) => patchDetails({ inland: v ? Number(v) : null })}
                />
                <InlineEdit
                  label="Agent Fee"
                  type="number"
                  value={details?.agent_fee}
                  onSave={(v) =>
                    patchDetails({ agent_fee: v ? Number(v) : null })
                  }
                />
                <InlineEdit
                  label="Insurance"
                  type="number"
                  value={details?.insurance}
                  onSave={(v) =>
                    patchDetails({ insurance: v ? Number(v) : null })
                  }
                />
                <InlineEdit
                  label="Total Cost"
                  type="number"
                  value={details?.total_cost}
                  onSave={(v) =>
                    patchDetails({ total_cost: v ? Number(v) : null })
                  }
                />
              </Section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <PanelSection title={title}>{children}</PanelSection>
  );
}
