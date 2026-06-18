import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ClipboardList, Save } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM } from "../../lib/scm";
import { Field, Input } from "./Suppliers";

// ── Picker response shapes (snake_case, verbatim from the Hono routes) ──────
// GET /api/scm/inventory/warehouses
interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}
// GET /api/scm/mfg-products — drives the category list + prefix suggestions so
// the commander doesn't have to remember every code shape.
interface ProductRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
}

type ScopeType = "ALL" | "CATEGORY" | "CODE_PREFIX";

// Today's date as YYYY-MM-DD for the <input type="date"> default.
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ScmStockTakeNew — full-page Create Stock Take at /scm/stock-takes/new.
 *
 * Step 1 only: pick warehouse + scope (ALL / CATEGORY / CODE_PREFIX) + date +
 * notes. On Create the server snapshots system_qty for every in-scope SKU and
 * opens the take; the commander then enters counted_qty per line on the detail
 * page (PATCH /:id/lines) before posting. So this page creates the take and
 * navigates to its detail — no count entry here. Create is not destructive
 * (an OPEN take writes no inventory movements), so it is NOT confirm-gated; the
 * only confirm is the "empty scope" guard.
 */
export function ScmStockTakeNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  const [warehouseId, setWarehouseId] = useState("");
  const [takeDate, setTakeDate] = useState(todayIso());
  const [scopeType, setScopeType] = useState<ScopeType>("ALL");
  const [scopeValue, setScopeValue] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const warehousesQ = useQuery<{ warehouses: WarehouseOption[] }>(
    () => api.get(`${SCM}/inventory/warehouses`),
    [],
  );
  const productsQ = useQuery<{ products: ProductRow[] }>(
    () => api.get(`${SCM}/mfg-products`),
    [],
  );

  const warehouses = warehousesQ.data?.warehouses ?? [];
  const products = productsQ.data?.products ?? [];

  // Categories sourced from the actual SKU master (distinct, sorted) so the
  // CATEGORY scope offers only values that exist — these match the server's
  // v_inventory_all_skus.category filter exactly.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (p.category && p.category.trim()) set.add(p.category.trim());
    }
    return Array.from(set).sort();
  }, [products]);

  // Suggested code prefixes from the master (top 2-3 letter prefixes by count).
  const prefixOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) {
      const m = (p.code ?? "").match(/^([A-Za-z]{2,3})/);
      const prefix = m?.[1]?.toUpperCase();
      if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([p]) => p);
  }, [products]);

  const needsScopeValue = scopeType === "CATEGORY" || scopeType === "CODE_PREFIX";

  // Live preview of the count-sheet size, computed against the loaded catalogue.
  // (ALL counts every SKU regardless of stock — the server's v_inventory_all_skus
  // cross-joins warehouse × SKU, so this is the SKU-master count, an upper bound
  // matching the snapshot it will produce.)
  const previewCount = useMemo(() => {
    if (!warehouseId) return 0;
    if (scopeType === "CATEGORY") {
      if (!scopeValue) return 0;
      return products.filter((p) => (p.category ?? "") === scopeValue).length;
    }
    if (scopeType === "CODE_PREFIX") {
      const pfx = scopeValue.trim().toUpperCase();
      if (!pfx) return products.length;
      return products.filter((p) => (p.code ?? "").toUpperCase().startsWith(pfx)).length;
    }
    return products.length;
  }, [products, scopeType, scopeValue, warehouseId]);

  const dirty = Boolean(warehouseId || scopeValue.trim() || notes.trim());

  async function submit() {
    if (!warehouseId) {
      toast.error("Pick a warehouse");
      return;
    }
    if (!takeDate) {
      toast.error("Take date is required");
      return;
    }
    if (needsScopeValue && !scopeValue.trim()) {
      toast.error(
        scopeType === "CATEGORY" ? "Pick a category" : "Enter a code prefix",
      );
      return;
    }
    if (previewCount === 0) {
      const ok = await dialog.confirm({
        title: "No SKUs match this scope",
        message:
          "The count sheet will be empty at the chosen warehouse and scope. Continue anyway?",
        confirmLabel: "Create anyway",
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      const res = await api.post<{ id: string; takeNo: string; lineCount: number }>(
        `${SCM}/stock-takes`,
        {
          warehouseId,
          takeDate,
          scopeType,
          scopeValue: needsScopeValue ? scopeValue.trim() : undefined,
          notes: notes.trim() || undefined,
        },
      );
      toast.success(`Stock take ${res.takeNo} created — ${res.lineCount} SKU(s) to count`);
      navigate(`/scm/stock-takes/${res.id}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(
        msg.includes("scope_empty")
          ? "No SKUs match the chosen scope"
          : `Failed to create stock take${msg ? `: ${msg}` : ""}`,
      );
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/stock-takes")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Stock Takes
      </button>

      <PageHeader
        eyebrow="Supply Chain"
        title="New Stock Take"
        description="Snapshot system qty for an in-scope SKU set, then count and post variance adjustments."
        primaryAction={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => navigate("/scm/stock-takes")}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button icon={<Save size={15} />} onClick={submit} disabled={saving}>
              {saving ? "Creating…" : "Create Count Sheet"}
            </Button>
          </div>
        }
      />

      {/* Setup card */}
      <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-px w-3 bg-accent/60" />
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Setup
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Warehouse" required>
            <select
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— Pick warehouse —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Take Date" required>
            <input
              type="date"
              value={takeDate}
              onChange={(e) => setTakeDate(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </Field>
          <Field label="Scope" required>
            <select
              value={scopeType}
              onChange={(e) => {
                setScopeType(e.target.value as ScopeType);
                setScopeValue("");
              }}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="ALL">All SKUs in warehouse</option>
              <option value="CATEGORY">By category</option>
              <option value="CODE_PREFIX">By code prefix</option>
            </select>
          </Field>
          <Field
            label={
              scopeType === "CATEGORY"
                ? "Category"
                : scopeType === "CODE_PREFIX"
                  ? "Code Prefix"
                  : "Scope Value"
            }
            required={needsScopeValue}
          >
            {scopeType === "CATEGORY" ? (
              <select
                value={scopeValue}
                onChange={(e) => setScopeValue(e.target.value)}
                className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
              >
                <option value="">— Pick category —</option>
                {categoryOptions.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            ) : scopeType === "CODE_PREFIX" ? (
              <>
                <input
                  type="text"
                  list="stk-prefix-suggestions"
                  value={scopeValue}
                  onChange={(e) => setScopeValue(e.target.value.toUpperCase())}
                  placeholder="e.g. BF, MAT, SOF…"
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <datalist id="stk-prefix-suggestions">
                  {prefixOptions.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </>
            ) : (
              <input
                type="text"
                value="All SKUs"
                disabled
                className="h-10 w-full rounded-md border border-border-subtle bg-bg/50 px-3 text-[13px] text-ink-muted outline-none"
              />
            )}
          </Field>
        </div>

        <div className="mt-3">
          <Field label="Notes">
            <Input
              value={notes}
              onChange={setNotes}
              placeholder="e.g. Monthly cycle count · main warehouse"
            />
          </Field>
        </div>

        {/* Count-sheet size preview */}
        <div className="mt-4 flex items-center gap-3 rounded-md border border-border-subtle bg-bg/50 px-4 py-3">
          <ClipboardList size={18} className="shrink-0 text-ink-muted" />
          <div className="text-[13px] text-ink-secondary">
            {!warehouseId ? (
              <span className="text-ink-muted">
                Pick a warehouse to preview the count sheet size.
              </span>
            ) : needsScopeValue && !scopeValue.trim() ? (
              <span className="text-ink-muted">
                {scopeType === "CATEGORY"
                  ? "Pick a category to preview the count sheet size."
                  : "Enter a code prefix to preview the count sheet size."}
              </span>
            ) : (
              <>
                Count sheet will contain{" "}
                <span className="font-mono font-semibold text-ink">
                  {previewCount.toLocaleString("en-MY")}
                </span>{" "}
                SKU{previewCount === 1 ? "" : "s"} with their current system qty snapshotted.
              </>
            )}
          </div>
        </div>
      </div>

      {/* Footer save mirrors the header action */}
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => navigate("/scm/stock-takes")}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button icon={<Save size={15} />} onClick={submit} disabled={saving || !dirty}>
          {saving ? "Creating…" : "Create Count Sheet"}
        </Button>
      </div>
    </div>
  );
}
