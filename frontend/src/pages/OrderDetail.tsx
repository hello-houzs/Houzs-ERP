import { useParams } from "react-router-dom";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
  StatStrip,
  DefinitionList,
} from "../components/DetailLayout";
import { InlineEdit } from "../components/InlineEdit";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import type { SalesOrder, OrderDetails } from "../types";

const DELIVERY_MESSAGE_STATUSES = [
  "to send delivery date",
  "pending customer reply (D)",
  "pending reschedule (D)",
  "done scheduling",
  "not sent (D)",
  "Pending Reschedule (A)",
  "Not sent (A)",
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
    <DetailLayout
      breadcrumbs={[
        { label: "Sales Orders", to: "/orders" },
        { label: docNo },
      ]}
      eyebrow={`Sales Order · ${docNo}${order?.region ? ` · ${order.region}` : ""}`}
      title={order?.debtor_name || "Loading…"}
      description={
        order
          ? `${formatDate(order.doc_date)}${order.transfer_to ? ` · D/O ${order.transfer_to}` : ""}${order.sales_agent ? ` · ${order.sales_agent}` : ""}`
          : undefined
      }
      backTo="/orders"
      loading={detail.loading && !order}
      error={detail.error}
    >
      {order && (
        <>
          <StatStrip
            items={[
              { label: "Total", value: formatCurrency(order.local_total) },
              {
                label: "Balance",
                value: formatCurrency(order.balance),
                tone: order.balance > 0 ? "err" : "ok",
              },
              {
                label: "Lines",
                value: lines.data?.lines?.length?.toLocaleString() ?? "—",
              },
              {
                label: "Expiry",
                value: order.expiry_date ? formatDate(order.expiry_date) : "—",
              },
            ]}
          />

          <div className="mt-5">
            <DetailGrid>
              <DetailMain>
                <Section
                  title={`Line Items${lines.data?.lines?.length ? ` · ${lines.data.lines.length}` : ""}`}
                  dense
                >
                  {lines.loading && (
                    <div className="px-4 py-4 text-[12px] text-ink-muted">
                      Loading line items…
                    </div>
                  )}
                  {lines.error && (
                    <div className="m-4 rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-err">
                      Could not fetch line items: {lines.error}
                    </div>
                  )}
                  {!lines.loading &&
                    !lines.error &&
                    (lines.data?.lines?.length ?? 0) === 0 && (
                      <div className="px-4 py-4 text-[12px] text-ink-muted">
                        No line items.
                      </div>
                    )}
                  {!lines.loading && (lines.data?.lines?.length ?? 0) > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12px]">
                        <thead className="bg-bg/50 text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
                          <tr>
                            <th className="px-4 py-2.5 text-left">Item</th>
                            <th className="px-3 py-2.5 text-left">Description</th>
                            <th className="px-3 py-2.5 text-right">Qty</th>
                            <th className="px-3 py-2.5 text-right">Price</th>
                            <th className="px-3 py-2.5 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.data!.lines.map((ln, i) => {
                            const desc =
                              ln.Description ?? ln.ItemDescription ?? "";
                            const qty = ln.Qty ?? null;
                            const price = ln.UnitPrice ?? null;
                            const amount = ln.Amount ?? null;
                            return (
                              <tr
                                key={i}
                                className="border-t border-border-subtle hover:bg-bg/40"
                              >
                                <td className="px-4 py-1.5 font-mono text-[11px]">
                                  {ln.ItemCode || "—"}
                                </td>
                                <td className="max-w-[260px] truncate px-3 py-1.5 text-ink-secondary">
                                  {desc || "—"}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono">
                                  {qty != null ? qty : "—"}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono">
                                  {price != null ? formatCurrency(price) : "—"}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono font-semibold">
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
                  <div className="space-y-2">
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
                  </div>
                </Section>

                {isEast && (
                  <Section title="Transporter (East)">
                    <div className="space-y-2">
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
                        onSave={(v) =>
                          patchDetails({ transporter_remarks: v })
                        }
                      />
                    </div>
                  </Section>
                )}

                {isEast && (
                  <Section title="Financials (East)">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {[
                        ["Seafreight", "seafreight"],
                        ["Local Charges", "local_charges"],
                        ["Inland", "inland"],
                        ["Agent Fee", "agent_fee"],
                        ["Insurance", "insurance"],
                        ["Total Cost", "total_cost"],
                      ].map(([label, key]) => (
                        <InlineEdit
                          key={key}
                          label={label}
                          type="number"
                          value={(details as any)?.[key]}
                          onSave={(v) =>
                            patchDetails({ [key]: v ? Number(v) : null })
                          }
                        />
                      ))}
                    </div>
                  </Section>
                )}
              </DetailMain>

              <DetailAside>
                <Section title="Order">
                  <DefinitionList
                    items={[
                      { label: "Doc No", value: order.doc_no, mono: true },
                      { label: "D/O", value: order.transfer_to || "—", mono: true },
                      { label: "Date", value: formatDate(order.doc_date) },
                      { label: "Ref", value: order.ref || "—" },
                      { label: "Agent", value: order.sales_agent || "—" },
                      { label: "Region", value: order.region },
                      {
                        label: "Total",
                        value: formatCurrency(order.local_total),
                        mono: true,
                      },
                      {
                        label: "Balance",
                        mono: true,
                        value: (
                          <span
                            className={cn(
                              order.balance > 0 && "font-semibold text-err"
                            )}
                          >
                            {formatCurrency(order.balance)}
                          </span>
                        ),
                      },
                    ]}
                  />
                </Section>

                <Section title="Address">
                  <div className="space-y-1 text-[12.5px] text-ink-secondary">
                    <div>{order.inv_addr1 || "—"}</div>
                    {order.inv_addr2 && <div>{order.inv_addr2}</div>}
                    {order.inv_addr3 && <div>{order.inv_addr3}</div>}
                    {order.inv_addr4 && <div>{order.inv_addr4}</div>}
                  </div>
                </Section>

                <Section title="Notes">
                  <DefinitionList
                    items={[
                      { label: "Remark 2", value: order.remark2, full: true },
                      { label: "Remark 3", value: order.remark3, full: true },
                      { label: "Note", value: order.note, full: true },
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
