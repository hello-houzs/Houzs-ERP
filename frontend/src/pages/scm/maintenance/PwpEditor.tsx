// ----------------------------------------------------------------------------
// PwpEditor — Maintenance tab body for Purchase-With-Purchase (换购) promos.
// Two sections:
//   1. PWP RULES — full CRUD. A rule: buying a TRIGGER (eligible model in a
//      category) unlocks REWARD models at their PWP price. Editor-role gated.
//   2. PWP CODES — read-only lookup. The codes route exposes NO list-all GET
//      (codes are minted per-cart at order time), only per-owner / per-SO /
//      single-code reads. So this section is a validate-by-code + lookup-by-SO
//      tool, not an editor. Stated plainly in the UI.
//
// API — backend/src/scm/routes/pwp-rules.ts, /api/scm/pwp-rules:
//   GET    /     -> { rules: Rule[] }   (every authed staff role)
//   POST   /     -> { rule } 201        (editor roles)
//   PATCH  /:id  -> { rule }            (editor roles)
//   DELETE /:id  -> { ok: true }        (editor roles)
//   Rule body (camelCase): triggerCategory, triggerEligibleModelIds[],
//     triggerComboIds[], rewardCategory, eligibleRewardModelIds[],
//     rewardComboIds[], qtyPerTrigger, type ('pwp'|'promo'), active.
//
// API — backend/src/scm/routes/pwp-codes.ts, /api/scm/pwp-codes:
//   GET /by-so/:docNo -> { codes }      (codes a SO earned/spent)
//   GET /:code        -> { valid, ... } (validate / redeem-preview)
//   (POST /reserve, DELETE /reserve, GET /mine are cart-runtime, not config.)
//
// Model-id / combo-id lists are stored as string arrays. The configurator wires
// them to real pickers; here we edit them as comma-separated id lists ([] = the
// whole category) — kept lean + explained inline. No naked edits; explicit Save;
// delete via useDialog().confirm. pg trap: rules dual-read camelCase ?? snake.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { Plus, Pencil, Trash2, Search } from "lucide-react";
import { Button } from "../../../components/Button";
import { DataTable, type Column } from "../../../components/DataTable";
import { Panel } from "../../../components/Panel";
import { useQuery } from "../../../hooks/useQuery";
import { useToast } from "../../../hooks/useToast";
import { useDialog } from "../../../hooks/useDialog";
import { api } from "../../../api/client";
import { SCM } from "../../../lib/scm";
import { cn } from "../../../lib/utils";
import { Field, Input } from "../Suppliers";

const CATEGORIES = ["SOFA", "BEDFRAME", "ACCESSORY", "MATTRESS", "SERVICE"] as const;
const TYPES = ["pwp", "promo"] as const;

// ── Rule shapes ──────────────────────────────────────────────────────────────
interface RuleApi {
  id: string;
  triggerCategory?: string;
  trigger_category?: string;
  triggerEligibleModelIds?: string[] | null;
  trigger_eligible_model_ids?: string[] | null;
  triggerComboIds?: string[] | null;
  trigger_combo_ids?: string[] | null;
  rewardCategory?: string;
  reward_category?: string;
  eligibleRewardModelIds?: string[] | null;
  eligible_reward_model_ids?: string[] | null;
  rewardComboIds?: string[] | null;
  reward_combo_ids?: string[] | null;
  qtyPerTrigger?: number;
  qty_per_trigger?: number;
  type?: string | null;
  active?: boolean;
}

interface Rule {
  id: string;
  triggerCategory: string;
  triggerEligibleModelIds: string[];
  triggerComboIds: string[];
  rewardCategory: string;
  eligibleRewardModelIds: string[];
  rewardComboIds: string[];
  qtyPerTrigger: number;
  type: "pwp" | "promo";
  active: boolean;
}

function normalizeRule(r: RuleApi): Rule {
  return {
    id: r.id,
    triggerCategory: r.triggerCategory ?? r.trigger_category ?? "SOFA",
    triggerEligibleModelIds: r.triggerEligibleModelIds ?? r.trigger_eligible_model_ids ?? [],
    triggerComboIds: r.triggerComboIds ?? r.trigger_combo_ids ?? [],
    rewardCategory: r.rewardCategory ?? r.reward_category ?? "SOFA",
    eligibleRewardModelIds: r.eligibleRewardModelIds ?? r.eligible_reward_model_ids ?? [],
    rewardComboIds: r.rewardComboIds ?? r.reward_combo_ids ?? [],
    qtyPerTrigger: r.qtyPerTrigger ?? r.qty_per_trigger ?? 1,
    type: ((r.type ?? "pwp") as "pwp" | "promo"),
    active: r.active ?? true,
  };
}

// CSV string <-> trimmed id array (drops blanks).
function listToCsv(list: string[]): string {
  return list.join(", ");
}
function csvToList(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function countLabel(list: string[]): string {
  return list.length === 0 ? "Whole category" : `${list.length} listed`;
}

export function PwpEditor() {
  return (
    <div className="space-y-6">
      <RulesSection />
      <CodesSection />
    </div>
  );
}

// ── Section 1: rules (full CRUD) ─────────────────────────────────────────────
function RulesSection() {
  const toast = useToast();
  const dialog = useDialog();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const list = useQuery<{ rules: RuleApi[] }>(() => api.get(`${SCM}/pwp-rules`), []);
  const rows = list.data ? list.data.rules.map(normalizeRule) : null;

  async function remove(r: Rule) {
    const ok = await dialog.confirm({
      title: "Delete PWP rule",
      message: `Delete this ${r.triggerCategory} → ${r.rewardCategory} rule? Existing earned codes are unaffected.`,
      danger: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeleting(r.id);
    try {
      await api.del(`${SCM}/pwp-rules/${r.id}`);
      toast.success("Rule deleted");
      list.reload();
    } catch {
      toast.error("Failed to delete rule");
    } finally {
      setDeleting(null);
    }
  }

  const columns: Column<Rule>[] = [
    {
      key: "trigger",
      label: "Trigger",
      render: (r) => (
        <span className="text-ink">
          <span className="font-semibold">{r.triggerCategory}</span>
          <span className="text-ink-muted"> · {countLabel(r.triggerEligibleModelIds.length ? r.triggerEligibleModelIds : r.triggerComboIds)}</span>
        </span>
      ),
      getValue: (r) => r.triggerCategory,
    },
    {
      key: "reward",
      label: "Reward",
      render: (r) => (
        <span className="text-ink">
          <span className="font-semibold">{r.rewardCategory}</span>
          <span className="text-ink-muted"> · {countLabel(r.eligibleRewardModelIds.length ? r.eligibleRewardModelIds : r.rewardComboIds)}</span>
        </span>
      ),
      getValue: (r) => r.rewardCategory,
    },
    {
      key: "qtyPerTrigger",
      label: "Qty / Trigger",
      align: "right",
      render: (r) => <span className="font-mono text-ink">{r.qtyPerTrigger}</span>,
      getValue: (r) => r.qtyPerTrigger,
    },
    {
      key: "type",
      label: "Type",
      render: (r) => (
        <span
          className={cn(
            "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold uppercase",
            r.type === "promo"
              ? "border-accent/30 bg-accent-soft text-accent"
              : "border-border bg-surface-dim text-ink-secondary",
          )}
        >
          {r.type}
        </span>
      ),
      getValue: (r) => r.type,
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
            title="Edit rule"
          >
            <Pencil size={12} />
            Edit
          </button>
          <button
            onClick={() => void remove(r)}
            disabled={deleting === r.id}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-err/40 bg-surface px-2 text-[11px] font-semibold text-err transition-colors hover:bg-err/5 hover:border-err disabled:opacity-50"
            title="Delete rule"
          >
            <Trash2 size={12} />
            Delete
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-[14px] font-bold text-ink">PWP Rules</h3>
          <p className="mt-0.5 max-w-2xl text-[12px] text-ink-secondary">
            Buying a trigger (an eligible model in the trigger category) earns codes that unlock reward models
            at their PWP price. An empty eligible list means the whole category qualifies. <span className="font-semibold">promo</span> rules
            let a zero-priced reward redeem for free; <span className="font-semibold">pwp</span> rules are paid 换购.
          </p>
        </div>
        <Button icon={<Plus size={15} />} onClick={() => setShowCreate(true)}>
          New Rule
        </Button>
      </div>

      <DataTable
        tableId="scm_pwp_rules"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search category, type…",
        }}
        emptyLabel="No PWP rules yet"
        exportName="pwp-rules"
      />

      {showCreate && (
        <RulePanel
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            list.reload();
          }}
        />
      )}

      {editing && (
        <RulePanel
          mode="edit"
          rule={editing}
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

interface RuleDraft {
  triggerCategory: string;
  triggerEligibleModelIds: string;
  triggerComboIds: string;
  rewardCategory: string;
  eligibleRewardModelIds: string;
  rewardComboIds: string;
  qtyPerTrigger: string;
  type: "pwp" | "promo";
  active: boolean;
}

function emptyDraft(): RuleDraft {
  return {
    triggerCategory: "SOFA",
    triggerEligibleModelIds: "",
    triggerComboIds: "",
    rewardCategory: "SOFA",
    eligibleRewardModelIds: "",
    rewardComboIds: "",
    qtyPerTrigger: "1",
    type: "pwp",
    active: true,
  };
}
function draftFromRule(r: Rule): RuleDraft {
  return {
    triggerCategory: r.triggerCategory,
    triggerEligibleModelIds: listToCsv(r.triggerEligibleModelIds),
    triggerComboIds: listToCsv(r.triggerComboIds),
    rewardCategory: r.rewardCategory,
    eligibleRewardModelIds: listToCsv(r.eligibleRewardModelIds),
    rewardComboIds: listToCsv(r.rewardComboIds),
    qtyPerTrigger: String(r.qtyPerTrigger),
    type: r.type,
    active: r.active,
  };
}

function RulePanel({
  mode,
  rule,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  rule?: Rule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const isEdit = mode === "edit";
  const [draft, setDraft] = useState<RuleDraft>(() => (rule ? draftFromRule(rule) : emptyDraft()));
  const set = (p: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...p }));

  const dirty = isEdit || JSON.stringify(draft) !== JSON.stringify(emptyDraft());

  async function submit() {
    const qty = Math.max(1, Math.trunc(Number(draft.qtyPerTrigger) || 1));
    const body = {
      triggerCategory: draft.triggerCategory,
      triggerEligibleModelIds: csvToList(draft.triggerEligibleModelIds),
      triggerComboIds: csvToList(draft.triggerComboIds),
      rewardCategory: draft.rewardCategory,
      eligibleRewardModelIds: csvToList(draft.eligibleRewardModelIds),
      rewardComboIds: csvToList(draft.rewardComboIds),
      qtyPerTrigger: qty,
      type: draft.type,
      active: draft.active,
    };

    setSaving(true);
    try {
      if (isEdit && rule) {
        await api.patch(`${SCM}/pwp-rules/${rule.id}`, body);
        toast.success("Rule updated");
      } else {
        await api.post(`${SCM}/pwp-rules`, body);
        toast.success("Rule created");
      }
      onSaved();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      if (msg.includes("forbidden") || msg.includes("403")) {
        toast.error("You don't have permission to edit PWP rules");
      } else if (msg.includes("409") || msg.includes("23505")) {
        toast.error("An active rule already exists for that trigger/reward pair");
      } else {
        toast.error(isEdit ? "Failed to update rule" : "Failed to create rule");
      }
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
      width={520}
      title={isEdit ? "Edit PWP Rule" : "New PWP Rule"}
      subtitle="Trigger category unlocks reward category. Model/combo id lists are comma-separated; leave blank for the whole category."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Create Rule"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Trigger */}
        <div className="rounded-lg border border-border bg-bg/40 p-3">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-brand text-ink-muted">Trigger</div>
          <div className="space-y-3">
            <Field label="Trigger Category" required>
              <CategorySelect value={draft.triggerCategory} onChange={(v) => set({ triggerCategory: v })} />
            </Field>
            <Field label="Eligible Model IDs (comma-separated, blank = whole category)">
              <Input value={draft.triggerEligibleModelIds} onChange={(v) => set({ triggerEligibleModelIds: v })} placeholder="uuid, uuid, …" />
            </Field>
            <Field label="Trigger Combo IDs (SOFA only)">
              <Input value={draft.triggerComboIds} onChange={(v) => set({ triggerComboIds: v })} placeholder="combo-id, …" />
            </Field>
          </div>
        </div>

        {/* Reward */}
        <div className="rounded-lg border border-border bg-bg/40 p-3">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-brand text-ink-muted">Reward</div>
          <div className="space-y-3">
            <Field label="Reward Category" required>
              <CategorySelect value={draft.rewardCategory} onChange={(v) => set({ rewardCategory: v })} />
            </Field>
            <Field label="Eligible Reward Model IDs (comma-separated, blank = whole category)">
              <Input value={draft.eligibleRewardModelIds} onChange={(v) => set({ eligibleRewardModelIds: v })} placeholder="uuid, uuid, …" />
            </Field>
            <Field label="Reward Combo IDs (SOFA only)">
              <Input value={draft.rewardComboIds} onChange={(v) => set({ rewardComboIds: v })} placeholder="combo-id, …" />
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Qty per Trigger" required>
            <Input value={draft.qtyPerTrigger} onChange={(v) => set({ qtyPerTrigger: v })} type="number" placeholder="1" />
          </Field>
          <Field label="Type" required>
            <select
              value={draft.type}
              onChange={(e) => set({ type: e.target.value as "pwp" | "promo" })}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
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
      </div>
    </Panel>
  );
}

function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
    >
      {CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

// ── Section 2: codes (read-only lookup) ──────────────────────────────────────
interface CodeApi {
  code: string;
  rewardCategory?: string;
  reward_category?: string;
  status: string;
  type?: string | null;
  sourceDocNo?: string | null;
  source_doc_no?: string | null;
  triggerItemCode?: string | null;
  trigger_item_code?: string | null;
}

function codeReward(c: CodeApi): string {
  return c.rewardCategory ?? c.reward_category ?? "—";
}
function codeSource(c: CodeApi): string {
  return c.sourceDocNo ?? c.source_doc_no ?? "—";
}

function CodesSection() {
  const toast = useToast();
  const [soNo, setSoNo] = useState("");
  const [soCodes, setSoCodes] = useState<CodeApi[] | null>(null);
  const [soLoading, setSoLoading] = useState(false);

  const [code, setCode] = useState("");
  const [codeResult, setCodeResult] = useState<{ valid: boolean; reason?: string; status?: string; rewardCategory?: string; type?: string } | null>(null);
  const [codeLoading, setCodeLoading] = useState(false);

  async function lookupSo() {
    const doc = soNo.trim();
    if (!doc) {
      toast.error("Enter a sales order number");
      return;
    }
    setSoLoading(true);
    try {
      const res = await api.get<{ codes: CodeApi[] }>(`${SCM}/pwp-codes/by-so/${encodeURIComponent(doc)}`);
      setSoCodes(res.codes ?? []);
    } catch {
      toast.error("Failed to look up codes for that SO");
      setSoCodes(null);
    } finally {
      setSoLoading(false);
    }
  }

  async function validateCode() {
    const c = code.trim();
    if (!c) {
      toast.error("Enter a code");
      return;
    }
    setCodeLoading(true);
    try {
      const res = await api.get<{ valid: boolean; reason?: string; status?: string; rewardCategory?: string; type?: string }>(
        `${SCM}/pwp-codes/${encodeURIComponent(c)}`,
      );
      setCodeResult(res);
    } catch {
      toast.error("Failed to validate code");
      setCodeResult(null);
    } finally {
      setCodeLoading(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border-subtle pt-5">
      <div>
        <h3 className="font-display text-[14px] font-bold text-ink">PWP Codes</h3>
        <p className="mt-0.5 max-w-2xl text-[12px] text-ink-secondary">
          Codes are minted automatically when a trigger is added to a cart — there's no master list to edit.
          Use these read-only lookups to inspect the codes a sales order earned or to validate a single code.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Lookup by SO */}
        <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-brand text-ink-muted">Codes by Sales Order</div>
          <div className="flex items-center gap-2">
            <input
              value={soNo}
              onChange={(e) => setSoNo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void lookupSo();
              }}
              placeholder="SO document no."
              className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <Button icon={<Search size={14} />} onClick={() => void lookupSo()} disabled={soLoading}>
              {soLoading ? "…" : "Look up"}
            </Button>
          </div>

          {soCodes !== null && (
            <div className="mt-3">
              {soCodes.length === 0 ? (
                <p className="text-[12px] text-ink-muted">No PWP codes recorded for that SO.</p>
              ) : (
                <ul className="space-y-1.5">
                  {soCodes.map((c) => (
                    <li key={c.code} className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg/40 px-3 py-1.5">
                      <span className="font-mono text-[12px] font-semibold text-ink">{c.code}</span>
                      <span className="text-[11px] text-ink-secondary">
                        {codeReward(c)} · {c.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Validate a code */}
        <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-brand text-ink-muted">Validate a Code</div>
          <div className="flex items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void validateCode();
              }}
              placeholder="PWP-1234ABCD"
              className="h-9 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <Button icon={<Search size={14} />} onClick={() => void validateCode()} disabled={codeLoading}>
              {codeLoading ? "…" : "Check"}
            </Button>
          </div>

          {codeResult && (
            <div className="mt-3 rounded-md border border-border bg-bg/40 px-3 py-2 text-[12px]">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                    codeResult.valid ? "bg-synced/15 text-synced border-synced/30" : "bg-err/10 text-err border-err/30",
                  )}
                >
                  {codeResult.valid ? "Valid" : "Not valid"}
                </span>
                {codeResult.status && <span className="text-ink-secondary">{codeResult.status}</span>}
                {codeResult.type && <span className="text-ink-muted">· {codeResult.type}</span>}
              </div>
              {codeResult.rewardCategory && (
                <div className="mt-1 text-ink-secondary">Reward category: {codeResult.rewardCategory}</div>
              )}
              {!codeResult.valid && codeResult.reason && (
                <div className="mt-1 text-ink-muted">Reason: {codeResult.reason.replace(/_/g, " ")}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
