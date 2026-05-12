import { useEffect, useMemo, useState } from "react";
import { Trash2, Plus, RotateCcw } from "lucide-react";
import { Panel, PanelSection } from "./Panel";
import { Button } from "./Button";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { cn, formatCurrency } from "../lib/utils";
import type {
  SalesRep,
  SalesPosition,
  SalesRepTier,
} from "../types";

interface BrandRow {
  id: number;
  name: string;
  color: string;
  active: number;
}

type Tab = "profile" | "commission";

/**
 * Edit-rep panel matching the boss's mockup. Two tabs:
 *   - Profile & Brands — name, code, phone, email, IC no., status,
 *     position, upline (primary + secondary), assigned brands.
 *   - Commission — personal floor rate, tiered table (threshold +
 *     rate %), and a calculator preview.
 *
 * Open via `<SalesRepEditPanel rep={...} onClose={...} onSaved={...} />`.
 */
export function SalesRepEditPanel({
  rep,
  allReps,
  onClose,
  onSaved,
  canManage,
}: {
  rep: SalesRep;
  allReps: SalesRep[];
  onClose: () => void;
  onSaved: () => void;
  canManage: boolean;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [tab, setTab] = useState<Tab>("profile");

  // Profile state — local until Save.
  const [name, setName] = useState(rep.name);
  const [phone, setPhone] = useState(rep.phone ?? "");
  const [email, setEmail] = useState(rep.email ?? "");
  const [nric, setNric] = useState(rep.nric ?? "");
  const [status, setStatus] = useState(rep.status);
  const [positionId, setPositionId] = useState<number | null>(rep.position_id);
  const [uplineId, setUplineId] = useState<number | null>(rep.upline_id);
  const [uplineSecondaryId, setUplineSecondaryId] = useState<number | null>(
    rep.upline_secondary_id ?? null,
  );
  const [brands, setBrands] = useState<string[]>(rep.brands);

  // Commission state.
  const [minRate, setMinRate] = useState<string>(
    rep.commission_min_rate != null ? String(rep.commission_min_rate) : "0",
  );
  const [tiers, setTiers] = useState<SalesRepTier[]>([]);
  const [tiersLoaded, setTiersLoaded] = useState(false);

  const [saving, setSaving] = useState(false);

  const positionsQ = useQuery<{ data: SalesPosition[] }>(() =>
    api.get("/api/sales-team/lookups/positions"),
  );
  const brandsQ = useQuery<{ data: BrandRow[] }>(() =>
    api.get("/api/projects/brands?full=1"),
  );

  // Lazy-load custom tiers when the Commission tab opens.
  useEffect(() => {
    if (tab !== "commission" || tiersLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: SalesRepTier[] }>(
          `/api/sales-team/reps/${rep.id}/commission-tiers`,
        );
        if (cancelled) return;
        setTiers(
          res.data.length > 0
            ? res.data
            : [{ threshold: 0, rate: 0, sort_order: 0 }],
        );
        setTiersLoaded(true);
      } catch (e: any) {
        toast.error(e?.message || "Failed to load tiers");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, tiersLoaded, rep.id, toast]);

  // Reps eligible to be upline. Exclude self + descendants (server
  // checks again, but UI hides obvious-loop options to begin with).
  const descendantIds = useMemo(() => {
    const set = new Set<number>([rep.id]);
    let frontier = [rep.id];
    while (frontier.length) {
      const next: number[] = [];
      for (const r of allReps) {
        if (r.upline_id != null && set.has(r.upline_id) && !set.has(r.id)) {
          set.add(r.id);
          next.push(r.id);
        }
      }
      frontier = next;
    }
    return set;
  }, [allReps, rep.id]);

  const uplineOptions = useMemo(
    () =>
      allReps.filter(
        (r) =>
          r.id !== rep.id &&
          !descendantIds.has(r.id) &&
          r.archived_at == null &&
          r.status === "active",
      ),
    [allReps, descendantIds, rep.id],
  );

  function toggleBrand(b: string) {
    setBrands((cur) =>
      cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b],
    );
  }

  async function saveProfile() {
    if (!canManage) return;
    setSaving(true);
    try {
      await api.patch(`/api/sales-team/reps/${rep.id}`, {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        nric: nric.trim() || null,
        status,
        position_id: positionId,
        upline_id: uplineId,
        upline_secondary_id: uplineSecondaryId,
        brands,
      });
      onSaved();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveCommission() {
    if (!canManage) return;
    setSaving(true);
    try {
      const cleanedTiers = tiers
        .map((t) => ({
          threshold: Number(t.threshold) || 0,
          rate: Number(t.rate) || 0,
        }))
        .filter((t) => t.threshold >= 0 && t.rate >= 0);
      await api.patch(`/api/sales-team/reps/${rep.id}`, {
        commission_min_rate: Number(minRate) || 0,
      });
      await api.put(`/api/sales-team/reps/${rep.id}/commission-tiers`, {
        tiers: cleanedTiers,
      });
      onSaved();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (
      !(await dialog.confirm({
        title: "Remove rep?",
        message: `Soft-delete ${rep.name}? Their orders keep their reference.`,
        danger: true,
        confirmLabel: "Remove",
      }))
    )
      return;
    try {
      await api.del(`/api/sales-team/reps/${rep.id}`);
      onSaved();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  function addTier() {
    setTiers((cur) => [
      ...cur,
      { threshold: 0, rate: 0, sort_order: cur.length * 10 },
    ]);
  }
  function patchTier(idx: number, body: Partial<SalesRepTier>) {
    setTiers((cur) => cur.map((t, i) => (i === idx ? { ...t, ...body } : t)));
  }
  function removeTier(idx: number) {
    setTiers((cur) => cur.filter((_, i) => i !== idx));
  }
  function resetTiers() {
    setTiers([{ threshold: 0, rate: 5, sort_order: 0 }]);
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={rep.name}
      subtitle={`Edit · ${rep.code}`}
      width={620}
      footer={
        <div className="flex items-center justify-between gap-2">
          {canManage && (
            <button
              onClick={remove}
              className="inline-flex items-center gap-1 rounded-md border border-err/40 bg-surface px-3 py-2 text-[12px] font-semibold text-err hover:bg-err/10"
            >
              <Trash2 size={12} /> Remove
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary"
            >
              Cancel
            </button>
            {canManage && (
              <Button
                variant="primary"
                onClick={tab === "commission" ? saveCommission : saveProfile}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {/* Tab strip */}
      <div className="mb-4 border-b border-border">
        <div className="flex items-center gap-1">
          {(
            [
              { value: "profile", label: "Profile & Brands" },
              { value: "commission", label: "Commission" },
            ] as const
          ).map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={cn(
                "relative -mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-[12px] font-semibold transition-colors",
                tab === t.value
                  ? "border-accent text-accent"
                  : "border-transparent text-ink-secondary hover:text-ink",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "profile" && (
        <>
          <PanelSection title="Profile">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name" required>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!canManage}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg/40 disabled:text-ink-muted"
                />
              </Field>
              <Field label="Code">
                <input
                  value={rep.code}
                  disabled
                  className="h-9 w-full rounded-md border border-border bg-bg/40 px-3 text-[12.5px] text-ink-muted outline-none"
                />
              </Field>
              <Field label="Phone">
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={!canManage}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg/40 disabled:text-ink-muted"
                />
              </Field>
              <Field label="Email">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={!canManage}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg/40 disabled:text-ink-muted"
                />
              </Field>
              <Field label="IC No.">
                <input
                  value={nric}
                  onChange={(e) => setNric(e.target.value)}
                  disabled={!canManage}
                  placeholder="e.g. 880101-12-3456"
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg/40 disabled:text-ink-muted"
                />
              </Field>
              <Field label="Status">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as any)}
                  disabled={!canManage}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg/40 disabled:text-ink-muted"
                >
                  <option value="active">ACTIVE</option>
                  <option value="inactive">INACTIVE</option>
                </select>
              </Field>
              <Field label="Position">
                <select
                  value={positionId ?? ""}
                  onChange={(e) =>
                    setPositionId(e.target.value ? parseInt(e.target.value, 10) : null)
                  }
                  disabled={!canManage}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg/40 disabled:text-ink-muted"
                >
                  <option value="">— None —</option>
                  {(positionsQ.data?.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Upline (Primary)">
                <select
                  value={uplineId ?? ""}
                  onChange={(e) =>
                    setUplineId(e.target.value ? parseInt(e.target.value, 10) : null)
                  }
                  disabled={!canManage}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg/40 disabled:text-ink-muted"
                >
                  <option value="">— None —</option>
                  {uplineOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.position_name ? ` (${r.position_name})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Upline (Secondary, optional)">
                <select
                  value={uplineSecondaryId ?? ""}
                  onChange={(e) =>
                    setUplineSecondaryId(
                      e.target.value ? parseInt(e.target.value, 10) : null,
                    )
                  }
                  disabled={!canManage}
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-bg/40 disabled:text-ink-muted"
                >
                  <option value="">— None —</option>
                  {uplineOptions
                    .filter((r) => r.id !== uplineId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {r.position_name ? ` (${r.position_name})` : ""}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
          </PanelSection>

          <PanelSection title="Assigned Brands">
            <div className="flex flex-wrap gap-2">
              {(brandsQ.data?.data ?? []).map((b) => {
                const on = brands.includes(b.name);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => canManage && toggleBrand(b.name)}
                    disabled={!canManage}
                    style={
                      on
                        ? { backgroundColor: `#${b.color}`, color: "white" }
                        : undefined
                    }
                    className={cn(
                      "rounded-md px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wider transition-colors",
                      !on && "border border-border bg-surface text-ink-secondary hover:border-accent/40",
                      !canManage && "cursor-not-allowed opacity-60",
                    )}
                  >
                    {b.name}
                  </button>
                );
              })}
            </div>
          </PanelSection>
        </>
      )}

      {tab === "commission" && (
        <>
          <p className="mb-3 text-[11.5px] text-ink-secondary">
            Custom commission tiers for this member. Override the global tier
            assigned on the Profile tab.
          </p>

          <PanelSection title="Minimum Commission Rate (%)">
            <div className="flex items-center gap-3">
              <input
                type="number"
                step="0.5"
                min="0"
                value={minRate}
                onChange={(e) => setMinRate(e.target.value)}
                disabled={!canManage}
                className="input w-32 font-mono"
              />
              <span className="text-[11px] text-ink-muted">
                Personal floor rate — guaranteed minimum %
              </span>
            </div>
          </PanelSection>

          <PanelSection title="Tiers">
            <div className="overflow-hidden rounded-md border border-border">
              <div className="grid grid-cols-[1fr_120px_36px] gap-2 border-b border-border bg-bg/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                <div>Sales threshold (RM)</div>
                <div>Rate %</div>
                <div />
              </div>
              {tiers.length === 0 && (
                <div className="px-3 py-3 text-[11.5px] text-ink-muted">
                  No tiers — using the global default.
                </div>
              )}
              {tiers.map((t, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_120px_36px] items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0"
                >
                  <input
                    type="number"
                    step="100"
                    min="0"
                    value={t.threshold}
                    onChange={(e) =>
                      patchTier(i, { threshold: parseFloat(e.target.value) || 0 })
                    }
                    disabled={!canManage}
                    className="input font-mono"
                  />
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={t.rate}
                    onChange={(e) =>
                      patchTier(i, { rate: parseFloat(e.target.value) || 0 })
                    }
                    disabled={!canManage}
                    className="input font-mono"
                  />
                  {canManage && (
                    <button
                      onClick={() => removeTier(i)}
                      className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                      title="Remove tier"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canManage && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={addTier}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
                >
                  <Plus size={12} /> Add tier
                </button>
                <button
                  onClick={resetTiers}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink-secondary hover:border-accent/40"
                >
                  <RotateCcw size={12} /> Reset to default
                </button>
              </div>
            )}
          </PanelSection>

          <CommissionCalculator
            tiers={tiers}
            minRate={Number(minRate) || 0}
          />
        </>
      )}
    </Panel>
  );
}

// ── Helpers ──────────────────────────────────────────────────

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
        {required && <span className="ml-0.5 text-err">*</span>}
      </div>
      {children}
    </div>
  );
}

// Live commission calculator — picks the right tier from the
// per-rep table based on Personal + Group sales, applies the rate,
// subtracts a downline cost the user types in. All client-side; no
// network calls.
function CommissionCalculator({
  tiers,
  minRate,
}: {
  tiers: SalesRepTier[];
  minRate: number;
}) {
  const [personal, setPersonal] = useState(100000);
  const [group, setGroup] = useState(810000);
  const [downlineCost, setDownlineCost] = useState(40500);
  const teamTotal = personal + group;

  // Highest-threshold tier ≤ teamTotal wins. Personal floor rate is
  // a guaranteed minimum.
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  let rate = minRate;
  for (const t of sorted) {
    if (teamTotal >= t.threshold) rate = Math.max(rate, t.rate);
  }

  const gross = (teamTotal * rate) / 100;
  const net = gross - downlineCost;

  return (
    <PanelSection title="Commission Calculator">
      <div className="grid grid-cols-3 gap-3 rounded-md border border-border bg-bg/30 p-3 text-[11px]">
        <CalcField
          label="Personal Sales"
          value={personal}
          onChange={(n) => setPersonal(n)}
        />
        <CalcField
          label="Group Sales"
          value={group}
          onChange={(n) => setGroup(n)}
        />
        <CalcField
          label="Downline Cost"
          value={downlineCost}
          onChange={(n) => setDownlineCost(n)}
        />
      </div>
      <div className="mt-2 rounded-md border border-border bg-surface px-4 py-2 text-[12.5px]">
        <Row label="Team Total" value={formatCurrency(teamTotal)} />
        <Row label="Rate" value={`${rate}%`} />
        <Row label="Gross Commission" value={formatCurrency(gross)} />
        <Row
          label="− Downline Cost"
          value={`(${formatCurrency(downlineCost)})`}
          tone="err"
        />
        <div className="my-1 h-px bg-border" />
        <Row
          label="Net Commission"
          value={formatCurrency(net)}
          bold
          tone={net >= 0 ? "synced" : "err"}
        />
      </div>
    </PanelSection>
  );
}

function CalcField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <input
        type="number"
        min="0"
        step="100"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="input w-full font-mono"
      />
    </label>
  );
}

function Row({
  label,
  value,
  bold,
  tone,
}: {
  label: string;
  value: string;
  bold?: boolean;
  tone?: "synced" | "err";
}) {
  return (
    <div className={cn("flex items-baseline justify-between py-0.5", bold && "font-bold")}>
      <span className={cn(!bold && "text-ink-secondary")}>{label}</span>
      <span
        className={cn(
          "font-mono tabular-nums",
          tone === "err" && "text-err",
          tone === "synced" && "text-synced",
        )}
      >
        {value}
      </span>
    </div>
  );
}
