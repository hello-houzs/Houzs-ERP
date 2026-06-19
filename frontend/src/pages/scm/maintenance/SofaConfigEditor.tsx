// ----------------------------------------------------------------------------
// SofaConfigEditor — the Maintenance editor for the variant OPTION POOLS the SO
// sofa/bedframe configurator (SoLineCard) reads. Self-contained tab body: it
// fetches its own data and saves its own changes. No props, no routing.
//
// Data source: GET /api/scm/maintenance-config/resolved?scope=master → the raw
// JSON config blob stored in maintenance_config_history.config. We edit only the
// five pools the configurator consumes and PRESERVE every other key on save
// (the blob also carries bedframe/specials/branding/etc. pools owned by other
// editors — clobbering them would wipe live config). Save appends an
// effective-dated row via POST /maintenance-config/changes.
//
// Pool shapes (verbatim from backend/src/scm/shared/{mfg-pricing,maintenance-pools}.ts):
//   • STRING pools  (gaps, sofaSizes)        → MaintPoolEntry = string | { value, active? }
//   • PRICED pools  (sofaLegHeights,
//                    divanHeights, legHeights) → MfgPricedOption =
//        { value, priceSen, costSen?, sellingPriceSen?, active? }
//     priceSen        = COST-side surcharge (read by computeMfgLineCost)
//     sellingPriceSen = SELLING surcharge the configurator shows + sums (PR #265)
//     active=false    = hidden from NEW-entry pickers; existing docs still resolve
//
// pg camelCase trap: the resolved blob is an app-controlled JSON (NOT a SQL row),
// so its keys are the camelCase keys above — no snake_case dual-read needed for
// the pool entries themselves. The envelope (data/effectiveFrom/hasPendingPriceChange)
// is hand-built by the Hono route in camelCase too.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Plus, Trash2, Pencil, History, Clock } from "lucide-react";
import { Button } from "../../../components/Button";
import { useQuery } from "../../../hooks/useQuery";
import { useToast } from "../../../hooks/useToast";
import { useDialog } from "../../../hooks/useDialog";
import { api } from "../../../api/client";
import { SCM, fmtCenti } from "../../../lib/scm";
import { cn } from "../../../lib/utils";

// ── Pool entry shapes (mirrors the backend shared types) ────────────────────
type MaintPoolEntry = string | { value: string; active?: boolean };
interface PricedOption {
  value: string;
  priceSen?: number;
  costSen?: number;
  sellingPriceSen?: number;
  active?: boolean;
}

// The config blob is open-ended — we type the five pools we touch and keep the
// rest as an index signature so unknown keys survive a round-trip untouched.
interface MaintConfig {
  sofaSizes?: MaintPoolEntry[];
  gaps?: MaintPoolEntry[];
  sofaLegHeights?: PricedOption[];
  divanHeights?: PricedOption[];
  legHeights?: PricedOption[];
  [key: string]: unknown;
}

interface ResolvedResponse {
  data: MaintConfig | null;
  effectiveFrom: string | null;
  hasPendingPriceChange: boolean;
  pendingEffectiveFrom: string | null;
}

interface HistoryRow {
  id: string;
  scope: string;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  createdBy: string | null;
  isPending: boolean;
}
interface HistoryResponse {
  history: HistoryRow[];
}

const SCOPE = "master";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => new Date().toISOString().slice(0, 10);

// ── Pool catalogue — the five the SO sofa/bedframe configurator reads ───────
type StringPoolKey = "sofaSizes" | "gaps";
type PricedPoolKey = "sofaLegHeights" | "divanHeights" | "legHeights";
type PoolKey = StringPoolKey | PricedPoolKey;

interface PoolDef {
  key: PoolKey;
  label: string;
  description: string;
  section: "Sofa" | "Bedframe";
  priced: boolean;
}

const POOLS: PoolDef[] = [
  { key: "sofaSizes", label: "Sofa Sizes", description: "Sofa seat-height sizes (inches). No surcharge — drives the seat-height picker.", section: "Sofa", priced: false },
  { key: "sofaLegHeights", label: "Sofa Leg Heights", description: "Sofa leg-height options with cost + selling surcharge.", section: "Sofa", priced: true },
  { key: "divanHeights", label: "Divan Heights", description: "Bedframe divan-height options with cost + selling surcharge.", section: "Bedframe", priced: true },
  { key: "legHeights", label: "Bedframe Leg Heights", description: "Bedframe leg-height options with cost + selling surcharge.", section: "Bedframe", priced: true },
  { key: "gaps", label: "Gaps", description: "Bedframe gap-height options (inches). No surcharge.", section: "Bedframe", priced: false },
];

const SECTIONS: Array<PoolDef["section"]> = ["Sofa", "Bedframe"];

// ── Entry helpers — keep the byte-shape stable so untouched configs don't
// produce dirty diffs (plain string when active, object only when needed). ───
const entryValue = (e: MaintPoolEntry): string => (typeof e === "string" ? e : e.value);
const entryActive = (e: MaintPoolEntry): boolean => (typeof e === "string" ? true : e.active !== false);
const withValue = (e: MaintPoolEntry, value: string): MaintPoolEntry =>
  typeof e === "string" ? value : { ...e, value };
const withActive = (e: MaintPoolEntry, active: boolean): MaintPoolEntry =>
  active ? entryValue(e) : { value: entryValue(e), active: false };

function rmToSen(s: string): number {
  const n = Number(s.trim());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function senToRm(sen: number | null | undefined): string {
  return ((sen ?? 0) / 100).toFixed(2);
}

const inputCls =
  "h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20";
const moneyInputCls =
  "h-9 w-24 rounded-md border border-border bg-surface px-2 text-right font-mono text-[12px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20";

export function SofaConfigEditor() {
  const toast = useToast();
  const dialog = useDialog();

  const resolved = useQuery<ResolvedResponse>(
    () => api.get(`${SCM}/maintenance-config/resolved?scope=${SCOPE}`),
    [],
  );
  const history = useQuery<HistoryResponse>(
    () => api.get(`${SCM}/maintenance-config/history?scope=${SCOPE}`),
    [],
  );

  const liveConfig = resolved.data?.data ?? null;

  const [activeKey, setActiveKey] = useState<PoolKey>("sofaSizes");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<MaintConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const config = draft ?? liveConfig;
  const activeDef = POOLS.find((p) => p.key === activeKey)!;

  function startEdit() {
    if (!liveConfig) {
      toast.error("No config baseline to edit yet");
      return;
    }
    // Deep-clone the WHOLE blob — including the keys other editors own — so a
    // save round-trips them untouched.
    setDraft(JSON.parse(JSON.stringify(liveConfig)) as MaintConfig);
    setEditMode(true);
  }
  function cancelEdit() {
    setDraft(null);
    setEditMode(false);
  }

  // Mutate one pool inside the draft, replacing the whole array immutably.
  function setPool(key: PoolKey, next: MaintPoolEntry[] | PricedOption[]) {
    setDraft((d) => (d ? { ...d, [key]: next } : d));
  }

  async function save() {
    if (!draft) return;
    const effectiveFrom = await dialog.prompt({
      title: "Save sofa config",
      message: "Effective from which date? Pricing/options apply on and after this date.",
      defaultValue: todayIso(),
      placeholder: "YYYY-MM-DD",
      required: true,
    });
    if (!effectiveFrom) return;
    if (!ISO_DATE.test(effectiveFrom.trim())) {
      toast.error("Date must be YYYY-MM-DD");
      return;
    }
    setSaving(true);
    try {
      await api.post(`${SCM}/maintenance-config/changes`, {
        scope: SCOPE,
        config: draft,
        effectiveFrom: effectiveFrom.trim(),
      });
      toast.success("Sofa config saved");
      setDraft(null);
      setEditMode(false);
      resolved.reload();
      history.reload();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(msg.includes("forbidden") ? "You don't have permission to edit config" : "Failed to save config");
    } finally {
      setSaving(false);
    }
  }

  async function deletePending(row: HistoryRow) {
    const ok = await dialog.confirm({
      title: "Cancel scheduled change",
      message: `Remove the pending config scheduled for ${row.effectiveFrom}? The live config is unaffected.`,
      confirmLabel: "Cancel change",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`${SCM}/maintenance-config/changes/${row.id}`);
      toast.success("Pending change cancelled");
      history.reload();
      resolved.reload();
    } catch {
      toast.error("Failed to cancel the change");
    }
  }

  if (resolved.loading) {
    return <p className="py-8 text-center text-[13px] text-ink-muted">Loading maintenance config…</p>;
  }
  if (resolved.error) {
    return (
      <div className="rounded-lg border border-err/30 bg-err/5 p-4 text-[13px] text-ink">
        <strong>Failed to load maintenance config.</strong>
        <div className="mt-1 text-ink-secondary">{resolved.error}</div>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="rounded-lg border border-border bg-surface-dim p-4 text-[13px] text-ink-secondary">
        No maintenance config baseline found for the master scope yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
          {resolved.data?.effectiveFrom && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1">
              <Clock size={13} className="text-ink-muted" />
              Effective from <span className="font-mono text-ink">{resolved.data.effectiveFrom}</span>
            </span>
          )}
          {resolved.data?.hasPendingPriceChange && resolved.data.pendingEffectiveFrom && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-warning-text/30 bg-warning-bg px-2.5 py-1 text-warning-text">
              Pending change {resolved.data.pendingEffectiveFrom}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<History size={15} />}
            onClick={() => setShowHistory((s) => !s)}
          >
            History
          </Button>
          {editMode ? (
            <>
              <Button variant="secondary" onClick={cancelEdit} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save Changes"}
              </Button>
            </>
          ) : (
            <Button icon={<Pencil size={15} />} onClick={startEdit}>
              Edit
            </Button>
          )}
        </div>
      </div>

      {showHistory && <HistoryPanel q={history} onDelete={deletePending} editing={editMode} />}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
        {/* Left rail — pool picker grouped by section */}
        <aside className="space-y-3">
          {SECTIONS.map((section) => (
            <div key={section}>
              <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-brand text-ink-muted">
                {section}
              </div>
              <div className="space-y-1">
                {POOLS.filter((p) => p.section === section).map((p) => {
                  const arr = (config[p.key] as unknown[] | undefined) ?? [];
                  return (
                    <button
                      key={p.key}
                      onClick={() => setActiveKey(p.key)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-md border px-3 py-1.5 text-left text-[12px] font-semibold transition-colors",
                        activeKey === p.key
                          ? "border-accent bg-accent-soft text-accent"
                          : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                      )}
                    >
                      <span>{p.label}</span>
                      <span className="font-mono text-[10px] text-ink-muted">{arr.length}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </aside>

        {/* Right pane — the active pool's editor */}
        <section className="min-w-0">
          <div className="mb-3">
            <h3 className="font-display text-[15px] font-bold text-ink">{activeDef.label}</h3>
            <p className="text-[12px] text-ink-muted">{activeDef.description}</p>
          </div>

          {activeDef.priced ? (
            <PricedPoolEditor
              items={(config[activeKey] as PricedOption[] | undefined) ?? []}
              editMode={editMode}
              onChange={(next) => setPool(activeKey, next)}
            />
          ) : (
            <StringPoolEditor
              items={(config[activeKey] as MaintPoolEntry[] | undefined) ?? []}
              editMode={editMode}
              onChange={(next) => setPool(activeKey, next)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

// ── String pool editor (sofaSizes, gaps) ────────────────────────────────────
function StringPoolEditor({
  items,
  editMode,
  onChange,
}: {
  items: MaintPoolEntry[];
  editMode: boolean;
  onChange: (next: MaintPoolEntry[]) => void;
}) {
  const [draftValue, setDraftValue] = useState("");

  function addItem() {
    const v = draftValue.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraftValue("");
  }
  function removeAt(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }
  function editAt(idx: number, value: string) {
    onChange(items.map((e, i) => (i === idx ? withValue(e, value) : e)));
  }
  function toggleAt(idx: number, active: boolean) {
    onChange(items.map((e, i) => (i === idx ? withActive(e, active) : e)));
  }

  if (items.length === 0 && !editMode) {
    return <p className="rounded-md border border-border bg-surface-dim p-3 text-[12px] text-ink-muted">No options yet.</p>;
  }

  return (
    <div className="space-y-1.5">
      {items.map((e, i) => {
        const active = entryActive(e);
        return (
          <div
            key={`${entryValue(e)}-${i}`}
            className={cn(
              "flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2",
              !active && "opacity-60",
            )}
          >
            <span className="w-6 shrink-0 text-center font-mono text-[11px] text-ink-muted">{i + 1}</span>
            {editMode ? (
              <input className={cn(inputCls, "max-w-[260px] flex-1")} value={entryValue(e)} onChange={(ev) => editAt(i, ev.target.value)} />
            ) : (
              <span className="flex-1 text-[13px] font-medium text-ink">{entryValue(e)}</span>
            )}
            <ActiveControl editMode={editMode} active={active} onChange={(a) => toggleAt(i, a)} />
            {editMode && (
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="shrink-0 rounded p-1 text-err transition-colors hover:bg-err/10"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        );
      })}

      {editMode && (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-accent/50 bg-accent-soft/30 px-3 py-2">
          <span className="w-6 shrink-0 text-center text-ink-muted">
            <Plus size={14} className="mx-auto" />
          </span>
          <input
            className={cn(inputCls, "max-w-[260px] flex-1")}
            placeholder="New value (e.g. 24)"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addItem();
              }
            }}
          />
          <Button variant="secondary" icon={<Plus size={14} />} onClick={addItem}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Priced pool editor (sofaLegHeights, divanHeights, legHeights) ────────────
// Each row carries a SELLING surcharge (what the configurator shows + sums) and
// a COST surcharge (priceSen, read by the cost compute). Both are editable.
function PricedPoolEditor({
  items,
  editMode,
  onChange,
}: {
  items: PricedOption[];
  editMode: boolean;
  onChange: (next: PricedOption[]) => void;
}) {
  const [draftValue, setDraftValue] = useState("");
  const [draftSelling, setDraftSelling] = useState("0.00");
  const [draftCost, setDraftCost] = useState("0.00");

  function addItem() {
    const v = draftValue.trim();
    if (!v) return;
    const sellingPriceSen = rmToSen(draftSelling);
    const priceSen = rmToSen(draftCost);
    // priceSen (cost) is the historic primary field — always write it.
    // sellingPriceSen is opt-in (only when non-zero) to keep the byte shape
    // stable with rows authored by the cost-only flow.
    const row: PricedOption =
      sellingPriceSen > 0 ? { value: v, priceSen, sellingPriceSen } : { value: v, priceSen };
    onChange([...items, row]);
    setDraftValue("");
    setDraftSelling("0.00");
    setDraftCost("0.00");
  }
  function removeAt(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }
  function patchAt(idx: number, patch: Partial<PricedOption>) {
    onChange(items.map((o, i) => (i === idx ? { ...o, ...patch } : o)));
  }
  function setSelling(idx: number, sen: number) {
    onChange(
      items.map((o, i) => {
        if (i !== idx) return o;
        const next = { ...o };
        if (sen > 0) next.sellingPriceSen = sen;
        else delete next.sellingPriceSen;
        return next;
      }),
    );
  }
  function toggleActive(idx: number, active: boolean) {
    onChange(
      items.map((o, i) => {
        if (i !== idx) return o;
        const next = { ...o };
        if (active) delete next.active;
        else next.active = false;
        return next;
      }),
    );
  }

  const totalSelling = useMemo(() => items.reduce((acc, o) => acc + (o.sellingPriceSen ?? 0), 0), [items]);

  if (items.length === 0 && !editMode) {
    return <p className="rounded-md border border-border bg-surface-dim p-3 text-[12px] text-ink-muted">No options yet.</p>;
  }

  return (
    <div className="space-y-1.5">
      {/* Column header */}
      <div className="flex items-center gap-3 px-3 pb-1 text-[10px] font-bold uppercase tracking-brand text-ink-muted">
        <span className="w-6 shrink-0" />
        <span className="flex-1">Option</span>
        <span className="w-24 text-right">Selling</span>
        <span className="w-24 text-right">Cost</span>
        <span className="w-16 text-center">Active</span>
        {editMode && <span className="w-7 shrink-0" />}
      </div>

      {items.map((o, i) => {
        const active = o.active !== false;
        return (
          <div
            key={`${o.value}-${i}`}
            className={cn(
              "flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2",
              !active && "opacity-60",
            )}
          >
            <span className="w-6 shrink-0 text-center font-mono text-[11px] text-ink-muted">{i + 1}</span>
            {editMode ? (
              <input className={cn(inputCls, "min-w-0 flex-1")} value={o.value} onChange={(e) => patchAt(i, { value: e.target.value })} />
            ) : (
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{o.value}</span>
            )}

            {/* Selling surcharge — the configurator reads this */}
            {editMode ? (
              <input
                className={moneyInputCls}
                type="number"
                step="0.01"
                value={senToRm(o.sellingPriceSen)}
                onChange={(e) => setSelling(i, rmToSen(e.target.value))}
                title="Selling surcharge (shown + summed in the SO configurator)"
              />
            ) : (
              <span className={cn("w-24 text-right font-mono text-[12px]", o.sellingPriceSen ? "text-ink" : "text-ink-muted")}>
                {o.sellingPriceSen ? fmtCenti(o.sellingPriceSen) : "—"}
              </span>
            )}

            {/* Cost surcharge — priceSen, read by the cost compute */}
            {editMode ? (
              <input
                className={cn(moneyInputCls, "border-dashed")}
                type="number"
                step="0.01"
                value={senToRm(o.priceSen)}
                onChange={(e) => patchAt(i, { priceSen: rmToSen(e.target.value) })}
                title="Cost surcharge (cost-side benchmark; not shown to the customer)"
              />
            ) : (
              <span className={cn("w-24 text-right font-mono text-[12px]", o.priceSen ? "text-ink-secondary" : "text-ink-muted")}>
                {o.priceSen ? fmtCenti(o.priceSen) : "—"}
              </span>
            )}

            <span className="w-16 text-center">
              <ActiveControl editMode={editMode} active={active} onChange={(a) => toggleActive(i, a)} />
            </span>

            {editMode && (
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="w-7 shrink-0 rounded p-1 text-err transition-colors hover:bg-err/10"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        );
      })}

      {editMode && (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-accent/50 bg-accent-soft/30 px-3 py-2">
          <span className="w-6 shrink-0 text-center text-ink-muted">
            <Plus size={14} className="mx-auto" />
          </span>
          <input
            className={cn(inputCls, "min-w-0 flex-1")}
            placeholder="New value"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addItem();
              }
            }}
          />
          <input
            className={moneyInputCls}
            type="number"
            step="0.01"
            value={draftSelling}
            onChange={(e) => setDraftSelling(e.target.value)}
            title="Selling surcharge"
          />
          <input
            className={cn(moneyInputCls, "border-dashed")}
            type="number"
            step="0.01"
            value={draftCost}
            onChange={(e) => setDraftCost(e.target.value)}
            title="Cost surcharge"
          />
          <span className="w-16" />
          <Button variant="secondary" icon={<Plus size={14} />} onClick={addItem} className="w-auto">
            Add
          </Button>
        </div>
      )}

      {!editMode && items.length > 0 && (
        <div className="flex items-center justify-end gap-2 px-3 pt-1 text-[11px] text-ink-muted">
          Total selling surcharge pool:
          <span className="font-mono text-ink-secondary">{fmtCenti(totalSelling)}</span>
        </div>
      )}
    </div>
  );
}

// ── Active toggle / badge — shared by both editors ──────────────────────────
function ActiveControl({
  editMode,
  active,
  onChange,
}: {
  editMode: boolean;
  active: boolean;
  onChange: (active: boolean) => void;
}) {
  if (editMode) {
    return (
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-secondary" title="Inactive options are hidden from new-entry pickers; existing documents still resolve them">
        <input type="checkbox" checked={active} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
        Active
      </label>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold",
        active ? "border-synced/30 bg-synced/15 text-synced" : "border-border bg-surface-dim text-ink-muted",
      )}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

// ── History panel — append-only audit + cancel-pending ──────────────────────
function HistoryPanel({
  q,
  onDelete,
  editing,
}: {
  q: ReturnType<typeof useQuery<HistoryResponse>>;
  onDelete: (row: HistoryRow) => void;
  editing: boolean;
}) {
  const rows = q.data?.history ?? [];
  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-brand text-ink-muted">Config history</div>
      {q.loading ? (
        <p className="text-[12px] text-ink-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[12px] text-ink-muted">No history yet.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px]"
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-ink">{r.effectiveFrom}</span>
                {r.isPending && (
                  <span className="rounded border border-warning-text/30 bg-warning-bg px-1.5 py-0.5 text-[10px] font-semibold text-warning-text">
                    Pending
                  </span>
                )}
                {r.notes && <span className="text-ink-muted">· {r.notes}</span>}
              </span>
              {/* Cancel only ever a pending (future) row — past rows are the
                  effective record and never deletable from here. */}
              {r.isPending && !editing && (
                <button
                  type="button"
                  onClick={() => onDelete(r)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-err transition-colors hover:bg-err/10"
                  title="Cancel this scheduled change"
                >
                  <Trash2 size={12} />
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
