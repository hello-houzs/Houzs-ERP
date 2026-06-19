import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, X } from "lucide-react";
import { Button } from "../../../components/Button";
import { Panel } from "../../../components/Panel";
import { useQuery } from "../../../hooks/useQuery";
import { useToast } from "../../../hooks/useToast";
import { useDialog } from "../../../hooks/useDialog";
import { api, buildQuery } from "../../../api/client";
import { SCM, fmtCenti } from "../../../lib/scm";
import { cn } from "../../../lib/utils";
import { Field, Input } from "../Suppliers";

// ── Sofa Combos config editor ───────────────────────────────────────────────
// A tab body for a parent maintenance hub. Ported faithfully from 2990's
// SofaComboTab (apps/backend/src/components/SofaComboTab.tsx) into Houzs's
// Tailwind kit. Talks to /api/scm/sofa-combos (backend/src/scm/routes/sofa-combos.ts).
//
// A combo is a module-set deal on a base model: when a built sofa fills the
// combo's module slots, the combo price overrides per-module pricing. Each
// combo carries TWO per-height price maps:
//   · pricesByHeight        = COST  (PO benchmark / Product-Maintenance cost)
//   · sellingPricesByHeight = SELLING (what the customer pays)
// These are DISTINCT and must never be swapped. This editor edits both grids
// side by side, with the same seat-height columns.
//
// Append-only history: the backend never UPDATEs a combo — POST and PUT both
// INSERT a fresh effective-dated row keyed on the same scope tuple (base model,
// modules, tier, customer, supplier). "Editing" a combo therefore means saving
// a new effective row; the previous row stays in the table (filtered out of the
// active list once a fresher row supersedes it).
//
// SCOPE: this editor works the sales-side / master scope only (supplierId
// omitted, customerId null) — the same default the Products page uses. The
// backend's supplier-anchor mirroring (R8) and the customer/PWP/free-gift scopes
// are out of scope here (see "Deferred" notes at the bottom of the file).

// Wire shape from GET /api/scm/sofa-combos ({ rules: [...] }). The Hono route
// returns camelCase via rowToWire(), but the pg driver camelCases result
// columns inconsistently across the stack — dual-read camelCase ?? snake_case
// at every access (the #1 recurring bug in this codebase).
interface ComboWire {
  id: string;
  baseModel?: string | null;
  base_model?: string | null;
  modules?: string[][] | null;
  tier?: string | null;
  customerId?: string | null;
  customer_id?: string | null;
  supplierId?: string | null;
  supplier_id?: string | null;
  // COST per height.
  pricesByHeight?: Record<string, number | null> | null;
  prices_by_height?: Record<string, number | null> | null;
  // SELLING per height.
  sellingPricesByHeight?: Record<string, number | null> | null;
  selling_prices_by_height?: Record<string, number | null> | null;
  label?: string | null;
  effectiveFrom?: string | null;
  effective_from?: string | null;
  notes?: string | null;
}

// Normalised, fully-resolved combo the UI works with — every dual-read settled.
interface Combo {
  id: string;
  baseModel: string;
  modules: string[][];
  tier: string | null;
  cost: Record<string, number | null>;
  selling: Record<string, number | null>;
  label: string;
  effectiveFrom: string;
  notes: string;
}

const TIERS = ["PRICE_1", "PRICE_2", "PRICE_3"] as const;

// Default seat-height columns if no combo (and so no height keys) exists yet.
// Mirrors 2990's HEIGHTS_FALLBACK. The live column set is the union of these
// with every height key any loaded combo carries, so a combo priced on an
// unusual height still renders its column.
const HEIGHTS_FALLBACK = ["24", "26", "28", "30", "32", "35"];

function normalize(w: ComboWire): Combo {
  return {
    id: w.id,
    baseModel: (w.baseModel ?? w.base_model ?? "").trim(),
    modules: Array.isArray(w.modules) ? w.modules : [],
    tier: w.tier ?? null,
    cost: w.pricesByHeight ?? w.prices_by_height ?? {},
    selling: w.sellingPricesByHeight ?? w.selling_prices_by_height ?? {},
    label: w.label ?? "",
    effectiveFrom: (w.effectiveFrom ?? w.effective_from ?? "").slice(0, 10),
    notes: w.notes ?? "",
  };
}

// MYT-correct today (YYYY-MM-DD). The plain UTC slice can roll back a day before
// 08:00 MYT, which would default the effective date to "yesterday".
function todayIso(): string {
  const now = new Date();
  const myt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return myt.toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// A human label for a combo, derived from its module slots when none is stored.
// Each slot is an OR-set: "A | B" within a slot, " + " between slots.
function comboLabel(c: Combo): string {
  if (c.label.trim()) return c.label.trim();
  if (c.modules.length === 0) return "(no modules)";
  return c.modules.map((slot) => slot.join(" | ")).join(" + ");
}

// ── RM <-> centi helpers (money is integer *_centi / sen everywhere) ─────────
function senToRm(sen: number | null | undefined): string {
  if (sen == null) return "";
  return (sen / 100).toFixed(2);
}
function rmToSen(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function SofaCombosEditor() {
  const toast = useToast();
  const dialog = useDialog();
  const [baseModelFilter, setBaseModelFilter] = useState("");
  const [composer, setComposer] = useState<{ open: boolean; editing?: Combo }>({ open: false });

  // Sales-side / master scope: customerId=null (NULL scope), supplierId omitted.
  const list = useQuery<{ rules: ComboWire[] }>(
    () => api.get(`${SCM}/sofa-combos${buildQuery({ customerId: "__all__" })}`),
    [],
  );

  const combos = useMemo(() => (list.data?.rules ?? []).map(normalize), [list.data]);

  // Live seat-height columns: the fallback set unioned with every height key any
  // loaded combo carries (cost OR selling), numeric-then-alpha sorted.
  const heights = useMemo(() => {
    const set = new Set<string>(HEIGHTS_FALLBACK);
    for (const c of combos) {
      for (const k of Object.keys(c.cost)) set.add(k);
      for (const k of Object.keys(c.selling)) set.add(k);
    }
    return [...set].sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [combos]);

  const baseModels = useMemo(
    () => [...new Set(combos.map((c) => c.baseModel).filter(Boolean))].sort(),
    [combos],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, Combo[]>();
    for (const c of combos) {
      if (baseModelFilter && c.baseModel !== baseModelFilter) continue;
      const arr = map.get(c.baseModel) ?? [];
      arr.push(c);
      map.set(c.baseModel, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [combos, baseModelFilter]);

  const shown = grouped.reduce((n, [, rules]) => n + rules.length, 0);

  async function onDelete(c: Combo) {
    const ok = await dialog.confirm({
      title: "Delete combo",
      message: `Soft-delete the combo "${comboLabel(c)}" on ${c.baseModel}? It stays in history but stops pricing new builds.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`${SCM}/sofa-combos/${c.id}`);
      toast.success("Combo deleted");
      list.reload();
    } catch (e) {
      toast.error(String((e as Error)?.message ?? "Failed to delete combo"));
    }
  }

  return (
    <div className="space-y-4">
      {/* Header / intro */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-[16px] font-bold tracking-tight text-ink">Sofa Combos</h2>
          <p className="mt-1 max-w-[640px] text-[12.5px] leading-relaxed text-ink-secondary">
            Module-set combo deals per base model. Each combo carries a Cost grid (PO
            benchmark) and a Selling grid (customer price) across seat heights. Edits are
            append-only — saving creates a new effective-dated row; the old one stays in
            history.
          </p>
        </div>
        <Button icon={<Plus size={15} />} onClick={() => setComposer({ open: true })}>
          New Combo
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-stone">
        <select
          value={baseModelFilter}
          onChange={(e) => setBaseModelFilter(e.target.value)}
          className="h-9 rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        >
          <option value="">All base models</option>
          {baseModels.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[12.5px] text-ink-muted">
          {shown} {shown === 1 ? "combo" : "combos"}
        </span>
      </div>

      {/* List */}
      {list.loading ? (
        <div className="rounded-lg border border-border bg-surface px-4 py-10 text-center text-[13px] text-ink-muted shadow-stone">
          Loading combos…
        </div>
      ) : list.error ? (
        <div className="rounded-lg border border-err/30 bg-err/5 px-4 py-6 text-center text-[13px] text-err">
          {list.error}
        </div>
      ) : grouped.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-[13px] text-ink-muted shadow-stone">
          No combos yet. Click <span className="font-semibold text-ink-secondary">New Combo</span> to create one.
        </div>
      ) : (
        grouped.map(([model, rules]) => (
          <section key={model} className="space-y-2">
            <h3 className="px-1 text-[13px] font-bold text-ink">
              {model}{" "}
              <span className="font-normal text-ink-muted">
                ({rules.length} combo{rules.length !== 1 ? "s" : ""})
              </span>
            </h3>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {rules.map((c) => (
                <ComboCard
                  key={c.id}
                  combo={c}
                  heights={heights}
                  onEdit={() => setComposer({ open: true, editing: c })}
                  onDelete={() => onDelete(c)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {composer.open && (
        <ComposerPanel
          editing={composer.editing}
          heights={heights}
          knownBaseModels={baseModels}
          onClose={() => setComposer({ open: false })}
          onSaved={() => {
            setComposer({ open: false });
            list.reload();
          }}
        />
      )}
    </div>
  );
}

// ── Combo card ───────────────────────────────────────────────────────────────

function ComboCard({
  combo,
  heights,
  onEdit,
  onDelete,
}: {
  combo: Combo;
  heights: string[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const active = combo.effectiveFrom <= todayIso();
  return (
    <div className="rounded-lg border border-border bg-surface p-3.5 shadow-stone">
      <div className="flex items-start gap-2">
        <span className="rounded border border-border-strong bg-surface-dim px-2 py-0.5 font-mono text-[11px] font-semibold text-ink">
          {combo.baseModel || "—"}
        </span>
        <span className="min-w-0 flex-1 break-words text-[13px] font-medium text-ink">
          {comboLabel(combo)}
        </span>
        {combo.tier && (
          <span className="rounded border border-border bg-surface-dim px-1.5 py-0.5 text-[10px] font-semibold text-ink-secondary">
            {combo.tier}
          </span>
        )}
        <button
          onClick={onDelete}
          title="Soft-delete combo"
          className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Cost + Selling grids */}
      <div className="mt-3 space-y-2">
        <PriceRow label="Cost" map={combo.cost} heights={heights} tone="muted" />
        <PriceRow label="Selling" map={combo.selling} heights={heights} tone="strong" />
      </div>

      {/* Footer */}
      <div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-2.5">
        <span className="text-[11.5px] text-ink-muted">Effective {fmtDate(combo.effectiveFrom)}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold",
            active ? "bg-synced/15 text-synced" : "bg-surface-dim text-ink-muted",
          )}
        >
          {active ? "Active" : "Pending"}
        </span>
        <button
          onClick={onEdit}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
        >
          <Pencil size={12} />
          Edit
        </button>
      </div>
    </div>
  );
}

function PriceRow({
  label,
  map,
  heights,
  tone,
}: {
  label: string;
  map: Record<string, number | null>;
  heights: string[];
  tone: "muted" | "strong";
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {heights.map((h) => {
          const v = map[h];
          return (
            <div key={h} className="rounded bg-surface-dim px-1.5 py-1 text-center">
              <div className="text-[10px] text-ink-muted">{h}</div>
              <div
                className={cn(
                  "font-mono text-[11px] font-semibold",
                  v == null ? "text-ink-muted" : tone === "strong" ? "text-synced" : "text-ink",
                )}
              >
                {v == null ? "—" : fmtCenti(v)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Composer panel (New / Edit) ──────────────────────────────────────────────
// New  → POST /sofa-combos with the full tuple + both price grids.
// Edit → if the composition (base model / modules / tier) is unchanged, PUT
//        /sofa-combos/:id (new effective row on the same logical combo). If the
//        composition changed, POST a brand-new combo (the old one stays in
//        history) — matching 2990's append-only edit semantics.

interface SlotDraft {
  // Comma-separated OR-set of module codes for one slot, as raw text.
  text: string;
}

function ComposerPanel({
  editing,
  heights,
  knownBaseModels,
  onClose,
  onSaved,
}: {
  editing?: Combo;
  heights: string[];
  knownBaseModels: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [saving, setSaving] = useState(false);

  const [baseModel, setBaseModel] = useState(editing?.baseModel ?? "");
  const [slots, setSlots] = useState<SlotDraft[]>(() =>
    editing && editing.modules.length > 0
      ? editing.modules.map((slot) => ({ text: slot.join(", ") }))
      : [{ text: "" }],
  );
  const [tier, setTier] = useState<string>(editing?.tier ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(editing?.effectiveFrom || todayIso());
  const [notes, setNotes] = useState(editing?.notes ?? "");

  // Extra height columns the operator adds in this session (e.g. a brand-new
  // seat height not yet on any combo). Merged with the live `heights` set.
  const [extraHeights, setExtraHeights] = useState<string[]>([]);
  const [newHeight, setNewHeight] = useState("");
  const editorHeights = useMemo(() => {
    const set = new Set<string>([...heights, ...extraHeights]);
    return [...set].sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [heights, extraHeights]);

  // Price grids as RM strings keyed by height. Seeded from the combo being
  // edited; blank for a new combo.
  const [cost, setCost] = useState<Record<string, string>>(() => seedPrices(editing?.cost, heights));
  const [selling, setSelling] = useState<Record<string, string>>(() =>
    seedPrices(editing?.selling, heights),
  );

  function addHeight() {
    const h = newHeight.trim();
    if (!h) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(h)) {
      toast.error("Height must be alphanumeric (e.g. 24 or Flat)");
      return;
    }
    if (!editorHeights.includes(h)) setExtraHeights((cur) => [...cur, h]);
    setNewHeight("");
  }

  // Composition identity — base model + canonical module slots + tier. Drives
  // the PUT-vs-POST decision on save (same identity = append a new effective
  // row via PUT; changed = POST a brand-new combo).
  const compositionChanged = useMemo(() => {
    if (!editing) return false;
    const key = (bm: string, mods: string[][], t: string | null) =>
      JSON.stringify([
        bm,
        mods
          .map((slot) => [...new Set(slot.map((s) => s.trim()).filter(Boolean))].sort())
          .filter((slot) => slot.length > 0)
          .sort((a, b) => a.join("|").localeCompare(b.join("|"))),
        t ?? "",
      ]);
    const draftMods = slots.map((s) => splitSlot(s.text));
    return key(baseModel, draftMods, tier || null) !== key(editing.baseModel, editing.modules, editing.tier);
  }, [editing, baseModel, slots, tier]);

  async function submit() {
    if (!baseModel.trim()) {
      toast.error("Base model is required");
      return;
    }
    const modules = slots.map((s) => splitSlot(s.text)).filter((slot) => slot.length > 0);
    if (modules.length === 0) {
      toast.error("Add at least one module slot");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      toast.error("Effective date is required (YYYY-MM-DD)");
      return;
    }

    const costMap = buildPriceMap(cost, editorHeights);
    const sellingMap = buildPriceMap(selling, editorHeights);
    if (costMap === "bad" || sellingMap === "bad") {
      toast.error("Prices must be non-negative numbers");
      return;
    }
    // The backend rejects an all-null SELLING grid (nothing to charge).
    if (!Object.values(sellingMap).some((v) => v !== null)) {
      toast.error("At least one seat height needs a selling price");
      return;
    }

    // Label auto-derives from modules when blank; an explicit label is kept.
    const finalLabel = label.trim() || null;

    setSaving(true);
    try {
      if (editing && !compositionChanged) {
        // Same logical combo → PUT inserts a new effective row on the same tuple.
        await api.put(`${SCM}/sofa-combos/${editing.id}`, {
          pricesByHeight: costMap,
          sellingPricesByHeight: sellingMap,
          label: finalLabel,
          effectiveFrom,
          notes: notes.trim() || null,
        });
      } else {
        // New combo, or an edit that changed the composition → POST a fresh combo.
        await api.post(`${SCM}/sofa-combos`, {
          baseModel: baseModel.trim(),
          modules,
          tier: tier || null,
          customerId: null, // sales-side master scope (applies to all customers)
          pricesByHeight: costMap,
          sellingPricesByHeight: sellingMap,
          label: finalLabel,
          effectiveFrom,
          notes: notes.trim() || null,
        });
      }
      toast.success(editing ? "Combo saved (new effective row)" : "Combo created");
      onSaved();
    } catch (e) {
      toast.error(String((e as Error)?.message ?? "Failed to save combo"));
    } finally {
      setSaving(false);
    }
  }

  async function attemptClose() {
    const ok = await dialog.confirm({
      title: "Discard changes?",
      message: "This combo has unsaved changes. Close without saving?",
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok) onClose();
  }

  return (
    <Panel
      open
      onClose={onClose}
      dirty
      onAttemptClose={attemptClose}
      width={620}
      title={editing ? `Edit combo · ${editing.baseModel}` : "New combo"}
      subtitle={
        editing
          ? "Saving creates a new effective-dated row. The previous row stays in history."
          : "Create a module-set combo deal with Cost + Selling price grids."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={attemptClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save new row" : "Create combo"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Base model" required>
          <Input value={baseModel} onChange={setBaseModel} placeholder="e.g. Booqit" />
          {knownBaseModels.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {knownBaseModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setBaseModel(m)}
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                    baseModel === m
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </Field>

        {/* Module slots — each slot is an OR-set of codes (comma-separated). */}
        <Field label="Module slots">
          <p className="mb-2 text-[11px] leading-relaxed text-ink-muted">
            One slot per module position. Within a slot, list every code that may fill it,
            separated by commas (an OR-set, e.g. <span className="font-mono">2A(LHF), 2A(RHF)</span>).
          </p>
          <div className="space-y-2">
            {slots.map((slot, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Slot {idx + 1}
                </span>
                <input
                  value={slot.text}
                  onChange={(e) =>
                    setSlots((cur) => cur.map((s, i) => (i === idx ? { text: e.target.value } : s)))
                  }
                  placeholder="codes, comma-separated"
                  className="h-9 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <button
                  type="button"
                  onClick={() => setSlots((cur) => cur.filter((_, i) => i !== idx))}
                  disabled={slots.length === 1}
                  title="Remove slot"
                  className="shrink-0 rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-dim hover:text-ink disabled:opacity-30"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSlots((cur) => [...cur, { text: "" }])}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
          >
            <Plus size={13} /> Add slot
          </button>
          {compositionChanged && (
            <p className="mt-2 text-[11.5px] text-warning-text">
              The composition changed — saving creates a brand-new combo. The original stays in
              history.
            </p>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Tier">
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">Any tier</option>
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effective from" required>
            <input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </Field>
        </div>

        {/* Add a seat-height column. */}
        <Field label="Seat heights">
          <div className="flex items-center gap-2">
            <input
              value={newHeight}
              onChange={(e) => setNewHeight(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addHeight();
                }
              }}
              placeholder="add a height, e.g. 38 or Flat"
              className="h-9 w-56 rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="button"
              onClick={addHeight}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
            >
              <Plus size={13} /> Add
            </button>
          </div>
        </Field>

        {/* Cost grid (PO benchmark). */}
        <PriceGrid
          title="Cost by seat height (RM)"
          hint="PO benchmark / Product-Maintenance cost reference."
          heights={editorHeights}
          values={cost}
          onChange={(h, v) => setCost((cur) => ({ ...cur, [h]: v }))}
        />

        {/* Selling grid (what the customer pays). */}
        <PriceGrid
          title="Selling by seat height (RM)"
          hint="Customer-facing combo price. At least one height is required."
          heights={editorHeights}
          values={selling}
          onChange={(h, v) => setSelling((cur) => ({ ...cur, [h]: v }))}
        />

        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </Field>
      </div>
    </Panel>
  );
}

function PriceGrid({
  title,
  hint,
  heights,
  values,
  onChange,
}: {
  title: string;
  hint: string;
  heights: string[];
  values: Record<string, string>;
  onChange: (height: string, value: string) => void;
}) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">{title}</div>
      <p className="mb-2 text-[11px] text-ink-muted">{hint}</p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {heights.map((h) => (
          <div key={h}>
            <div className="mb-0.5 text-center text-[11px] text-ink-muted">{h}</div>
            <input
              type="number"
              step="0.01"
              min="0"
              value={values[h] ?? ""}
              onChange={(e) => onChange(h, e.target.value)}
              placeholder="—"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-right font-mono text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Split a slot's raw text ("2A(LHF), 2A(RHF)") into a de-duped OR-set of codes.
function splitSlot(text: string): string[] {
  return [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
}

// Seed a price-grid's RM-string map from a stored centi map, for every height.
function seedPrices(map: Record<string, number | null> | undefined, heights: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of heights) out[h] = senToRm(map?.[h]);
  // Keep any height the stored map carries that isn't in the column set.
  if (map) for (const [k, v] of Object.entries(map)) if (!(k in out)) out[k] = senToRm(v);
  return out;
}

// Build a centi price map from the RM-string grid. Returns "bad" if any cell is
// a negative or non-numeric value; empty cells become null.
function buildPriceMap(
  values: Record<string, string>,
  heights: string[],
): Record<string, number | null> | "bad" {
  const out: Record<string, number | null> = {};
  for (const h of heights) {
    const raw = (values[h] ?? "").trim();
    if (!raw) {
      out[h] = null;
      continue;
    }
    const sen = rmToSen(raw);
    if (sen == null) return "bad";
    out[h] = sen;
  }
  return out;
}
