import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM } from "../../lib/scm";

// Response shape from GET /api/scm/mrp-lead-times — the backend
// (backend/src/scm/routes/mrp-lead-times.ts) returns a camelCase map:
//   { leadTimes: { sofa: 0, bedframe: 7, mattress: 0, accessory: 0, service: 0 } }
// One integer per category = how many days BEFORE the customer delivery date a
// PO for that category is ordered (feeds the MRP "Order By" date). Five fixed
// categories. Read-only here (the backend PUT exists but editing is out of
// scope per the port brief).
type LeadCategory = "sofa" | "bedframe" | "mattress" | "accessory" | "service";

interface LeadTimesResult {
  leadTimes: Record<LeadCategory, number>;
}

interface LeadRow {
  category: LeadCategory;
  label: string;
  leadDays: number;
}

const CATEGORY_LABELS: Record<LeadCategory, string> = {
  sofa: "Sofa",
  bedframe: "Bedframe",
  mattress: "Mattress",
  accessory: "Accessory",
  service: "Service",
};

const ORDER: LeadCategory[] = ["sofa", "bedframe", "mattress", "accessory", "service"];

export function ScmMrpLeadTimes() {
  const navigate = useNavigate();
  const q = useQuery<LeadTimesResult>(() => api.get(`${SCM}/mrp-lead-times`), []);

  const rows: LeadRow[] | null = q.data
    ? ORDER.map((cat) => ({
        category: cat,
        label: CATEGORY_LABELS[cat],
        leadDays: q.data?.leadTimes?.[cat] ?? 0,
      }))
    : null;

  const columns: Column<LeadRow>[] = [
    {
      key: "category",
      label: "Category",
      render: (r) => <span className="font-medium text-ink">{r.label}</span>,
      getValue: (r) => r.label,
    },
    {
      key: "leadDays",
      label: "Lead Days",
      align: "right",
      render: (r) => (
        <span className="font-mono text-ink">
          {r.leadDays}
          <span className="ml-1 text-ink-muted">{r.leadDays === 1 ? "day" : "days"}</span>
        </span>
      ),
      getValue: (r) => r.leadDays,
    },
    {
      key: "effect",
      label: "Effect",
      render: (r) =>
        r.leadDays > 0 ? (
          <span className="text-[12px] text-ink-secondary">
            Order {r.leadDays} {r.leadDays === 1 ? "day" : "days"} before delivery
          </span>
        ) : (
          <span className="text-[12px] text-ink-muted">Order on the delivery date</span>
        ),
      getValue: (r) => r.leadDays,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="MRP Lead Times"
        description="Per-category order-ahead days. The MRP planner subtracts these from each Sales Order's delivery date to compute its order-by date. Read-only."
        primaryAction={
          <button
            type="button"
            onClick={() => navigate("/scm/mrp")}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
          >
            ← Back to MRP
          </button>
        }
      />

      <DataTable
        tableId="scm_mrp_lead_times"
        columns={columns}
        rows={rows}
        loading={q.loading}
        error={q.error}
        getRowKey={(r) => r.category}
        emptyLabel="No lead-time configuration found"
        exportName="mrp-lead-times"
      />
    </div>
  );
}
