import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "../../../components/Button";
import { DataTable, type Column } from "../../../components/DataTable";
import { Panel } from "../../../components/Panel";
import { useQuery } from "../../../hooks/useQuery";
import { useToast } from "../../../hooks/useToast";
import { useDialog } from "../../../hooks/useDialog";
import { api } from "../../../api/client";
import { SCM, fmtCenti } from "../../../lib/scm";
import { cn } from "../../../lib/utils";
import { Field, Input } from "../Suppliers";

// Special Add-ons config editor (tab body for a Maintenance hub). Backs the
// `special_addons` master that the SO sofa configurator reads — a special
// add-on is a per-Model surcharge (selling price, may be negative) plus 0..N
// follow-up question groups, NOT a SKU. Ported in structure from 2990's
// SpecialAddonsTab (apps/backend/src/components/SpecialAddonsTab.tsx) into the
// Houzs Tailwind kit.
//
// API — backend/src/scm/routes/special-addons.ts, mounted /api/scm/special-addons:
//   GET    /            -> { addons: Addon[] }  (every authed staff role)
//   POST   /            -> { addon }            (editor roles; 409 duplicate_code)
//   PATCH  /:id         -> { addon }            (editor roles; 409 duplicate_code)
//   DELETE /:id         -> { ok: true }         (editor roles)
// Bodies are camelCase; the route maps to snake_case columns. Money is integer
// *_sen (sellingPriceSen / costPriceSen / choice.extraSen), all may be negative.

// ── API shapes ──────────────────────────────────────────────────────────────
// GET returns camelCase already (route's toApi), but pg driver/casing has
// burned us before, so every read dual-reads camelCase ?? snake_case.
export interface OptionChoice {
  label: string;
  extraSen: number;
}
export interface OptionGroup {
  label: string;
  required: boolean;
  choices: OptionChoice[];
}
interface AddonRowApi {
  id: string;
  code: string;
  label: string;
  soDescription?: string;
  so_description?: string;
  categories: string[] | null;
  sellingPriceSen?: number;
  selling_price_sen?: number;
  costPriceSen?: number;
  cost_price_sen?: number;
  optionGroups?: OptionGroupApi[] | null;
  option_groups?: OptionGroupApi[] | null;
  active: boolean;
  sortOrder?: number;
  sort_order?: number;
}
interface OptionGroupApi {
  label: string;
  required?: boolean;
  choices?: OptionChoiceApi[] | null;
}
interface OptionChoiceApi {
  label: string;
  extraSen?: number;
  extra_sen?: number;
}

// Normalised row the UI works with (camelCase, never-null arrays).
interface Addon {
  id: string;
  code: string;
  label: string;
  soDescription: string;
  categories: string[];
  sellingPriceSen: number;
  costPriceSen: number;
  optionGroups: OptionGroup[];
  active: boolean;
  sortOrder: number;
}

function normalizeGroups(groups: OptionGroupApi[] | null | undefined): OptionGroup[] {
  return (groups ?? []).map((g) => ({
    label: g.label ?? "",
    required: g.required ?? true,
    choices: (g.choices ?? []).map((c) => ({
      label: c.label ?? "",
      extraSen: c.extraSen ?? c.extra_sen ?? 0,
    })),
  }));
}

function normalizeAddon(r: AddonRowApi): Addon {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    soDescription: r.soDescription ?? r.so_description ?? "",
    categories: r.categories ?? [],
    sellingPriceSen: r.sellingPriceSen ?? r.selling_price_sen ?? 0,
    costPriceSen: r.costPriceSen ?? r.cost_price_sen ?? 0,
    optionGroups: normalizeGroups(r.optionGroups ?? r.option_groups),
    active: r.active,
    sortOrder: r.sortOrder ?? r.sort_order ?? 0,
  };
}

// Categories the API enum accepts (CATEGORY z.enum in the route).
const CATEGORIES = ["SOFA", "BEDFRAME", "ACCESSORY", "MATTRESS", "SERVICE"] as const;

// ── Money helpers (RM string <-> integer sen). Negatives allowed: a special
// add-on or a choice may be a deduction. A blank / non-numeric field is 0 so a
// typo never lands a NaN in an int column. ───────────────────────────────────
function rmToSen(s: string): number {
  const t = s.trim();
  if (!t || t === "-") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function senToRm(sen: number): string {
  return (sen / 100).toString();
}
// Positive shows no sign ("RM 200.00"); negatives get a minus. Matches the
// other Maintenance panels (2990 Commander 2026-06-16).
function fmtSurcharge(sen: number): string {
  return sen < 0 ? `−${fmtCenti(-sen)}` : fmtCenti(sen);
}

// Draft used by both the create and edit panels.
interface Draft {
  code: string;
  label: string;
  soDescription: string;
  categories: string[];
  sellingPriceRm: string;
  costPriceRm: string;
  optionGroups: OptionGroup[];
  active: boolean;
  sortOrder: number;
}

function emptyDraft(): Draft {
  return {
    code: "",
    label: "",
    soDescription: "",
    categories: [],
    sellingPriceRm: "",
    costPriceRm: "",
    optionGroups: [],
    active: true,
    sortOrder: 0,
  };
}

function draftFromAddon(a: Addon): Draft {
  return {
    code: a.code,
    label: a.label,
    soDescription: a.soDescription,
    categories: [...a.categories],
    sellingPriceRm: senToRm(a.sellingPriceSen),
    costPriceRm: senToRm(a.costPriceSen),
    // deep clone so editing the draft never mutates the cached query row
    optionGroups: a.optionGroups.map((g) => ({
      label: g.label,
      required: g.required,
      choices: g.choices.map((c) => ({ label: c.label, extraSen: c.extraSen })),
    })),
    active: a.active,
    sortOrder: a.sortOrder,
  };
}

export function SpecialAddonsEditor() {
  const toast = useToast();
  const dialog = useDialog();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Addon | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const list = useQuery<{ addons: AddonRowApi[] }>(() => api.get(`${SCM}/special-addons`), []);
  const rows = list.data ? list.data.addons.map(normalizeAddon) : null;

  async function remove(a: Addon) {
    const ok = await dialog.confirm({
      title: "Delete special add-on",
      message: `Delete "${a.label}"? This removes the add-on definition. Existing orders keep their saved text.`,
      danger: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeletingId(a.id);
    try {
      await api.del(`${SCM}/special-addons/${a.id}`);
      toast.success("Special add-on deleted");
      list.reload();
    } catch {
      toast.error("Failed to delete special add-on");
    } finally {
      setDeletingId(null);
    }
  }

  const columns: Column<Addon>[] = [
    {
      key: "code",
      label: "Code",
      render: (r) => <span className="font-mono text-[12px] text-ink">{r.code}</span>,
      getValue: (r) => r.code,
    },
    {
      key: "label",
      label: "Add-on",
      render: (r) => (
        <span className="text-ink">
          <span className="font-medium">{r.label}</span>
          {r.soDescription && <span className="text-ink-muted"> · {r.soDescription}</span>}
        </span>
      ),
      getValue: (r) => r.label,
    },
    {
      key: "categories",
      label: "Categories",
      render: (r) => (
        <span className="text-[12px] text-ink-secondary">{r.categories.length ? r.categories.join(", ") : "—"}</span>
      ),
      getValue: (r) => r.categories.join(", "),
    },
    {
      key: "sellingPriceSen",
      label: "Base",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono", r.sellingPriceSen ? "text-ink" : "text-ink-muted")}>
          {fmtSurcharge(r.sellingPriceSen)}
        </span>
      ),
      getValue: (r) => r.sellingPriceSen,
    },
    {
      key: "followup",
      label: "Follow-up",
      render: (r) => (
        <span className="text-[12px] text-ink-secondary">
          {r.optionGroups.length === 0
            ? "—"
            : r.optionGroups.map((g) => `${g.label} (${g.choices.length})`).join(" · ")}
        </span>
      ),
      getValue: (r) => r.optionGroups.length,
    },
    {
      key: "active",
      label: "Status",
      render: (r) => (
        <span
          className={cn(
            "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
            r.active ? "bg-synced/15 text-synced border-synced/30" : "bg-surface-dim text-ink-muted border-border",
          )}
        >
          {r.active ? "Active" : "Off"}
        </span>
      ),
      getValue: (r) => (r.active ? "Active" : "Off"),
    },
    {
      key: "_actions",
      label: "",
      align: "right",
      alwaysVisible: true,
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <button
            onClick={() => setEditing(r)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
            title="Edit add-on"
          >
            <Pencil size={12} />
            Edit
          </button>
          <button
            onClick={() => void remove(r)}
            disabled={deletingId === r.id}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-err/40 bg-surface px-2 text-[11px] font-semibold text-err transition-colors hover:bg-err/5 hover:border-err disabled:opacity-50"
            title="Delete add-on"
          >
            <Trash2 size={12} />
            Delete
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-secondary">
          Each add-on = a name + SO description + applicable categories + a base surcharge (may be negative for a
          deduction) + 0 or more follow-up questions (e.g. Right Drawer → 10″ / 8″, each choice may carry its own
          price). These are the specials the SO sofa configurator offers. This only sets selling price — it never opens a
          new SKU.
        </p>
        <Button icon={<Plus size={15} />} onClick={() => setShowCreate(true)}>
          New Add-on
        </Button>
      </div>

      <DataTable
        tableId="scm_special_addons"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, name, description…",
        }}
        emptyLabel="No special add-ons yet"
        exportName="special-addons"
      />

      {showCreate && (
        <AddonPanel
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            list.reload();
          }}
        />
      )}

      {editing && (
        <AddonPanel
          mode="edit"
          addon={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

// ── Create / Edit panel ───────────────────────────────────────────────────
// Explicit Save only (no auto-save / no naked edit). `code` is the stable key
// the Model gate + SO line reference, so it is locked on edit (the route allows
// patching it but changing it would orphan existing references — same guard as
// 2990's editor). Body sent camelCase; categories/optionGroups go whole.
function AddonPanel({
  mode,
  addon,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  addon?: Addon;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => (addon ? draftFromAddon(addon) : emptyDraft()));
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const isEdit = mode === "edit";
  // Create starts pristine (guard the discard prompt); edit always treats the
  // panel as dirty so closing routes through the confirm-discard path.
  const dirty = isEdit || JSON.stringify(draft) !== JSON.stringify(emptyDraft());

  const toggleCat = (cat: string) =>
    set({
      categories: draft.categories.includes(cat)
        ? draft.categories.filter((c) => c !== cat)
        : [...draft.categories, cat],
    });

  // ── option_groups editor (the follow-up questions) ──────────────────────
  const setGroups = (groups: OptionGroup[]) => set({ optionGroups: groups });
  const addGroup = () =>
    setGroups([...draft.optionGroups, { label: "", required: true, choices: [{ label: "", extraSen: 0 }] }]);
  const removeGroup = (gi: number) => setGroups(draft.optionGroups.filter((_, i) => i !== gi));
  const patchGroup = (gi: number, p: Partial<OptionGroup>) =>
    setGroups(draft.optionGroups.map((g, i) => (i === gi ? { ...g, ...p } : g)));
  const addChoice = (gi: number) =>
    patchGroup(gi, { choices: [...draft.optionGroups[gi].choices, { label: "", extraSen: 0 }] });
  const patchChoice = (gi: number, ci: number, p: Partial<OptionChoice>) =>
    patchGroup(gi, {
      choices: draft.optionGroups[gi].choices.map((c, i) => (i === ci ? { ...c, ...p } : c)),
    });
  const removeChoice = (gi: number, ci: number) =>
    patchGroup(gi, { choices: draft.optionGroups[gi].choices.filter((_, i) => i !== ci) });

  async function submit() {
    if (!draft.code.trim()) {
      toast.error("Code is required");
      return;
    }
    if (!draft.label.trim()) {
      toast.error("Label is required");
      return;
    }
    if (draft.categories.length === 0) {
      toast.error("Pick at least one category");
      return;
    }
    for (const g of draft.optionGroups) {
      if (!g.label.trim()) {
        toast.error("Every follow-up question needs a label");
        return;
      }
      if (g.choices.length === 0 || g.choices.some((c) => !c.label.trim())) {
        toast.error(`"${g.label || "question"}" needs at least one named choice`);
        return;
      }
    }

    const body = {
      code: draft.code.trim(),
      label: draft.label.trim(),
      soDescription: draft.soDescription.trim(),
      categories: draft.categories,
      sellingPriceSen: rmToSen(draft.sellingPriceRm),
      costPriceSen: rmToSen(draft.costPriceRm),
      optionGroups: draft.optionGroups.map((g) => ({
        label: g.label.trim(),
        required: g.required,
        choices: g.choices.map((c) => ({ label: c.label.trim(), extraSen: c.extraSen })),
      })),
      active: draft.active,
      sortOrder: draft.sortOrder,
    };

    setSaving(true);
    try {
      if (isEdit && addon) {
        await api.patch(`${SCM}/special-addons/${addon.id}`, body);
        toast.success("Special add-on updated");
      } else {
        await api.post(`${SCM}/special-addons`, body);
        toast.success("Special add-on created");
      }
      onSaved();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(
        msg.includes("duplicate_code")
          ? "That code already exists"
          : isEdit
            ? "Failed to update special add-on"
            : "Failed to create special add-on",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      dirty={dirty}
      onAttemptClose={onClose}
      width={560}
      title={isEdit ? `Edit ${addon?.code}` : "New Special Add-on"}
      subtitle="A per-Model surcharge with optional follow-up questions. Selling price only — no new SKU."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Create Add-on"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required>
            {isEdit ? (
              <div className="flex h-10 items-center rounded-md border border-border bg-surface-dim px-3 font-mono text-[13px] text-ink-secondary">
                {draft.code}
              </div>
            ) : (
              <Input value={draft.code} onChange={(v) => set({ code: v })} placeholder="e.g. RIGHT-DRAWER" />
            )}
          </Field>
          <Field label="Label" required>
            <Input value={draft.label} onChange={(v) => set({ label: v })} placeholder="e.g. Right Drawer" />
          </Field>
        </div>

        {isEdit && (
          <p className="-mt-1 text-[11px] text-ink-muted">Code can't change after creation — it's the Model / order key.</p>
        )}

        <Field label="SO Description">
          <Input
            value={draft.soDescription}
            onChange={(v) => set({ soDescription: v })}
            placeholder="Prints under the product, e.g. Right pull-out drawer"
          />
        </Field>

        <Field label="Categories" required>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((cat) => {
              const on = draft.categories.includes(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCat(cat)}
                  className={cn(
                    "rounded-md border px-3 py-1 text-[12px] font-semibold capitalize transition-colors",
                    on
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                  )}
                >
                  {cat.toLowerCase()}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Base Price (RM, may be −)">
            <Input
              value={draft.sellingPriceRm}
              onChange={(v) => set({ sellingPriceRm: v })}
              type="number"
              placeholder="0.00"
            />
          </Field>
          <Field label="Cost Price (RM, may be −)">
            <Input
              value={draft.costPriceRm}
              onChange={(v) => set({ costPriceRm: v })}
              type="number"
              placeholder="0.00"
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => set({ active: e.target.checked })}
            className="h-4 w-4 rounded border-border text-accent focus:ring-accent/30"
          />
          Active (offered in the configurator)
        </label>

        {/* ── Follow-up questions (option_groups) ── */}
        <div className="border-t border-border-subtle pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
              Follow-up Questions
            </span>
            <button
              type="button"
              onClick={addGroup}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface px-2 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
            >
              <Plus size={12} />
              Add question
            </button>
          </div>

          {draft.optionGroups.length === 0 && (
            <p className="text-[12px] text-ink-muted">
              No follow-up questions. Add one if picking this add-on should ask the customer something (e.g. drawer side,
              thickness).
            </p>
          )}

          <div className="space-y-3">
            {draft.optionGroups.map((g, gi) => (
              <div key={gi} className="rounded-lg border border-border bg-bg/50 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    value={g.label}
                    onChange={(e) => patchGroup(gi, { label: e.target.value })}
                    placeholder="Question (e.g. Thickness)"
                    className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                  <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={g.required}
                      onChange={(e) => patchGroup(gi, { required: e.target.checked })}
                      className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
                    />
                    Required
                  </label>
                  <button
                    type="button"
                    onClick={() => removeGroup(gi)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-err/40 bg-surface text-err transition-colors hover:bg-err/5 hover:border-err"
                    title="Remove question"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                <div className="space-y-1.5 pl-3">
                  {g.choices.map((c, ci) => (
                    <div key={ci} className="flex items-center gap-2">
                      <input
                        value={c.label}
                        onChange={(e) => patchChoice(gi, ci, { label: e.target.value })}
                        placeholder={'Choice (e.g. 10")'}
                        className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                      />
                      <input
                        type="number"
                        value={senToRm(c.extraSen)}
                        onChange={(e) => patchChoice(gi, ci, { extraSen: rmToSen(e.target.value) })}
                        title="Extra RM (may be −)"
                        placeholder="0.00"
                        className="h-9 w-28 rounded-md border border-border bg-surface px-3 text-right text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                      />
                      <button
                        type="button"
                        onClick={() => removeChoice(gi, ci)}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-muted transition-colors hover:border-err/50 hover:text-err"
                        title="Remove choice"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => addChoice(gi)}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface px-2 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
                  >
                    <Plus size={11} />
                    Add choice
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}
