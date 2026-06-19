// ----------------------------------------------------------------------------
// FabricTierEditor — the Maintenance editor for the global fabric-tier selling
// add-on (the four Δ values the SO configurator adds when a fabric resolves to
// PRICE_2 / PRICE_3). Self-contained tab body: fetches + saves its own data.
//
// Data source:
//   GET   /api/scm/fabric-tier-addon → { sofaTier2Delta, sofaTier3Delta,
//          bedframeTier2Delta, bedframeTier3Delta, updatedAt, updatedBy }
//   PATCH /api/scm/fabric-tier-addon  body: any subset of the four camelCase
//          deltas (we send all four). 403 when the staff role isn't an editor.
//
// UNITS: each Δ is WHOLE MYR (NOT *_centi) — the route validates
// z.number().int().nonnegative() and the shared fabricTierAddon() returns whole
// MYR for one item (see backend/src/scm/shared/fabric-tier-addon.ts). So the
// inputs are plain integer ringgit, no sen decimals. SELLING-ONLY: this never
// touches cost. PRICE_1 is the base tier and always adds 0 (not configurable).
//
// pg camelCase: the route hand-builds the camelCase envelope, so we read
// camelCase directly. We still dual-read snake_case defensively in case the
// route ever returns the raw row.
//
// No naked edits: explicit Edit → Save (PATCH). No auto-save.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "../../../components/Button";
import { useQuery } from "../../../hooks/useQuery";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../api/client";
import { SCM } from "../../../lib/scm";
import { cn } from "../../../lib/utils";

// GET response — camelCase per the route. snake_case kept as a defensive
// dual-read (the repo-wide pg-camelCase trap).
interface FabricTierResponse {
  sofaTier2Delta?: number;
  sofaTier3Delta?: number;
  bedframeTier2Delta?: number;
  bedframeTier3Delta?: number;
  sofa_tier2_delta?: number;
  sofa_tier3_delta?: number;
  bedframe_tier2_delta?: number;
  bedframe_tier3_delta?: number;
  updatedAt?: string | null;
  updatedBy?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}

type DeltaKey = "sofaTier2Delta" | "sofaTier3Delta" | "bedframeTier2Delta" | "bedframeTier3Delta";

const FIELDS: Array<{
  key: DeltaKey;
  category: "Sofa" | "Bedframe";
  tier: "PRICE_2" | "PRICE_3";
}> = [
  { key: "sofaTier2Delta", category: "Sofa", tier: "PRICE_2" },
  { key: "sofaTier3Delta", category: "Sofa", tier: "PRICE_3" },
  { key: "bedframeTier2Delta", category: "Bedframe", tier: "PRICE_2" },
  { key: "bedframeTier3Delta", category: "Bedframe", tier: "PRICE_3" },
];

type DeltaForm = Record<DeltaKey, string>;

// Read a delta off the response honouring the camelCase ?? snake_case trap.
function readDelta(r: FabricTierResponse | null, key: DeltaKey): number {
  if (!r) return 0;
  const snake = key
    .replace("Tier", "_tier")
    .replace("Delta", "_delta")
    .toLowerCase() as keyof FabricTierResponse;
  const v = (r[key] as number | undefined) ?? (r[snake] as number | undefined);
  return typeof v === "number" ? v : 0;
}

// Whole-MYR integer parse: empty → 0, negatives clamped to 0, decimals trunc'd.
function parseMyr(s: string): number {
  const n = Number(s.trim());
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

export function FabricTierEditor() {
  const toast = useToast();

  const cfg = useQuery<FabricTierResponse>(() => api.get(`${SCM}/fabric-tier-addon`), []);

  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<DeltaForm>({
    sofaTier2Delta: "0",
    sofaTier3Delta: "0",
    bedframeTier2Delta: "0",
    bedframeTier3Delta: "0",
  });

  function startEdit() {
    if (!cfg.data) return;
    setForm({
      sofaTier2Delta: String(readDelta(cfg.data, "sofaTier2Delta")),
      sofaTier3Delta: String(readDelta(cfg.data, "sofaTier3Delta")),
      bedframeTier2Delta: String(readDelta(cfg.data, "bedframeTier2Delta")),
      bedframeTier3Delta: String(readDelta(cfg.data, "bedframeTier3Delta")),
    });
    setEditMode(true);
  }
  function cancelEdit() {
    setEditMode(false);
  }
  function set(key: DeltaKey, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      await api.patch(`${SCM}/fabric-tier-addon`, {
        sofaTier2Delta: parseMyr(form.sofaTier2Delta),
        sofaTier3Delta: parseMyr(form.sofaTier3Delta),
        bedframeTier2Delta: parseMyr(form.bedframeTier2Delta),
        bedframeTier3Delta: parseMyr(form.bedframeTier3Delta),
      });
      toast.success("Fabric tier add-on saved");
      setEditMode(false);
      cfg.reload();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(
        msg.includes("forbidden") || msg.includes("403")
          ? "You don't have permission to edit the fabric tier add-on"
          : "Failed to save fabric tier add-on",
      );
    } finally {
      setSaving(false);
    }
  }

  if (cfg.loading) {
    return <p className="py-8 text-center text-[13px] text-ink-muted">Loading fabric tier add-on…</p>;
  }
  if (cfg.error) {
    return (
      <div className="rounded-lg border border-err/30 bg-err/5 p-4 text-[13px] text-ink">
        <strong>Failed to load fabric tier add-on.</strong>
        <div className="mt-1 text-ink-secondary">{cfg.error}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-[12px] text-ink-secondary">
          Flat selling add-on (whole RM) applied per configured item when its fabric resolves to the
          given tier. PRICE_1 is the base tier and always adds nothing. This is selling-only — cost is
          unaffected. Per-model overrides live on each product model.
        </p>
        <div className="flex items-center gap-2">
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {(["Sofa", "Bedframe"] as const).map((category) => (
          <div key={category} className="rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="mb-3 text-[11px] font-bold uppercase tracking-brand text-ink-muted">{category}</div>
            <div className="space-y-3">
              {/* PRICE_1 — base tier, fixed at 0 (not stored, not editable). */}
              <DeltaRow label="Tier 1 (base)" hint="Always free" value={null} />
              {FIELDS.filter((f) => f.category === category).map((f) => (
                <DeltaRow
                  key={f.key}
                  label={`Tier ${f.tier === "PRICE_2" ? "2" : "3"}`}
                  hint={f.tier}
                  editMode={editMode}
                  value={editMode ? form[f.key] : readDelta(cfg.data, f.key)}
                  onChange={(v) => set(f.key, v)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {(cfg.data?.updatedAt ?? cfg.data?.updated_at) && (
        <p className="text-[11px] text-ink-muted">
          Last updated{" "}
          <span className="font-mono text-ink-secondary">
            {new Date(String(cfg.data?.updatedAt ?? cfg.data?.updated_at)).toLocaleString("en-MY")}
          </span>
        </p>
      )}
    </div>
  );
}

// One tier row — read display, edit input, or a fixed "free" base tier (value=null).
function DeltaRow({
  label,
  hint,
  value,
  editMode = false,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | string | null;
  editMode?: boolean;
  onChange?: (v: string) => void;
}) {
  const isBase = value === null;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink">{label}</div>
        <div className="text-[10px] uppercase tracking-brand text-ink-muted">{hint}</div>
      </div>
      {isBase ? (
        <span className="font-mono text-[13px] text-ink-muted">RM 0</span>
      ) : editMode ? (
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold text-ink-muted">RM</span>
          <input
            type="number"
            min={0}
            step={1}
            value={String(value)}
            onChange={(e) => onChange?.(e.target.value)}
            className={cn(
              "h-9 w-28 rounded-md border border-border bg-surface px-2 text-right font-mono text-[13px] text-ink outline-none transition-colors",
              "focus:border-accent focus:ring-2 focus:ring-accent/20",
            )}
          />
        </div>
      ) : (
        <span className="font-mono text-[14px] font-semibold text-ink">
          RM {Number(value).toLocaleString("en-MY")}
        </span>
      )}
    </div>
  );
}
