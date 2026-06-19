// ----------------------------------------------------------------------------
// FabricLibraryEditor — Maintenance tab body for the POS SELLING fabric library
// tiers. Distinct from Fabric Tracking (which is the procurement/cost converter
// over `fabric_trackings`); THIS edits the customer-pickable `fabric_library`
// rows that drive the SO selling-tier add-on.
//
// API — backend/src/scm/routes/fabric-library.ts, /api/scm/fabric-library:
//   PATCH /:id/tier   body { field: 'sofaTier'|'bedframeTier',
//                            tier: 'PRICE_1'|'PRICE_2'|'PRICE_3' } -> { ok: true }
//   (Master-Admin only; 403 → friendly toast.)
//
// EDIT-ONLY ROUTE: /fabric-library exposes ONLY this per-row tier PATCH — there
// is NO list/GET, no create, no delete on this route (fabric_library rows are
// seeded from the fabric converter, see fabric-tracking.ts). So this tab is a
// targeted tier setter: paste/enter a fabric_library row id and set its sofa /
// bedframe selling tier. No browseable list is available from the backend.
//
// No naked edits — explicit Save (PATCH). No money here (tiers are enum labels,
// not amounts); the per-tier RM delta lives in the Fabric Tier Add-on editor.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "../../../components/Button";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../api/client";
import { SCM } from "../../../lib/scm";
import { cn } from "../../../lib/utils";
import { Field, Input } from "../Suppliers";

const TIERS = ["PRICE_1", "PRICE_2", "PRICE_3"] as const;
type Tier = (typeof TIERS)[number];
type TierField = "sofaTier" | "bedframeTier";

function tierLabel(t: Tier): string {
  return t.replace("PRICE_", "Price ");
}

export function FabricLibraryEditor() {
  const toast = useToast();
  const [fabricId, setFabricId] = useState("");
  const [field, setField] = useState<TierField>("sofaTier");
  const [tier, setTier] = useState<Tier>("PRICE_1");
  const [saving, setSaving] = useState(false);

  async function save() {
    const id = fabricId.trim();
    if (!id) {
      toast.error("Enter a fabric library row id");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`${SCM}/fabric-library/${encodeURIComponent(id)}/tier`, { field, tier });
      toast.success(`${field === "sofaTier" ? "Sofa" : "Bedframe"} tier set to ${tierLabel(tier)}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      if (msg.includes("forbidden") || msg.includes("403")) {
        toast.error("You don't have permission to edit fabric library tiers");
      } else if (msg.includes("404") || msg.includes("not_found")) {
        toast.error("No fabric library row with that id");
      } else {
        toast.error("Failed to update fabric tier");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-warning-text/30 bg-warning-bg/40 p-3 text-[12px] text-ink-secondary">
        <strong className="text-ink">Edit-only route.</strong> The fabric-library API exposes only a
        per-row tier update — there's no listing, create, or delete endpoint here. Fabric library rows are
        seeded from the Fabric converter. Enter a known fabric library row id to set its selling tier.
      </div>

      <div className="max-w-lg space-y-3 rounded-lg border border-border bg-surface p-4 shadow-stone">
        <Field label="Fabric Library Row ID" required>
          <Input value={fabricId} onChange={setFabricId} placeholder="fabric_library.id (series id)" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Tier Field" required>
            <select
              value={field}
              onChange={(e) => setField(e.target.value as TierField)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="sofaTier">Sofa Tier</option>
              <option value="bedframeTier">Bedframe Tier</option>
            </select>
          </Field>

          <Field label="Tier" required>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as Tier)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {tierLabel(t)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* Tier preview chips for the chosen field. */}
        <div className="flex items-center gap-1.5 pt-1">
          {TIERS.map((t) => (
            <span
              key={t}
              className={cn(
                "inline-flex items-center rounded border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                t === tier
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-surface-dim text-ink-muted",
              )}
            >
              {tierLabel(t)}
            </span>
          ))}
        </div>

        <div className="flex justify-end pt-1">
          <Button icon={<Save size={15} />} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save Tier"}
          </Button>
        </div>
      </div>
    </div>
  );
}
