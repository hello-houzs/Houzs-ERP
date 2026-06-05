import { useState } from "react";
import { Clock, ClipboardCheck, DollarSign, LogOut, ChevronRight } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";

/**
 * Driver/Helper self-service profile page.
 * Shows: profile info, clock in/out, today's earnings, monthly salary, inspection status.
 */
export function DriverProfile() {
  const { user, logout } = useAuth();
  const toast = useToast();
  // Clock in/out is parked for now — UI hidden; backend, hooks and history
  // stay intact so toggling this back is a one-liner. See 2026-05-28
  // decision in the wiki.
  const CLOCK_ENABLED = false;
  const [tab, setTab] = useState<"profile" | "salary" | "clock">("profile");

  const profile = useQuery<any>(() => api.get("/api/fleet/me"));
  const clockStatus = useQuery<{ record: any }>(() => api.get("/api/fleet/clock/status"));
  const todayEarnings = useQuery<any>(() => api.get("/api/fleet/salary/today"));

  if (!user) return null;

  const clocked = clockStatus.data?.record;
  const isClockedIn = clocked && !clocked.clock_out;

  return (
    <div className="px-4 py-5">
      {/* Header */}
      <div className="mb-5">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">Profile</div>
        <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
          {user.name || user.email}
        </h1>
        <p className="mt-0.5 text-[12px] text-ink-secondary">{user.role_name}</p>
      </div>

      {/* Clock in/out card */}
      {CLOCK_ENABLED && (
        <ClockCard
          clocked={clocked}
          isClockedIn={isClockedIn}
          onReload={() => clockStatus.reload()}
        />
      )}

      {/* Today's earnings */}
      {todayEarnings.data && (
        <div className="mb-4 rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                Today's Earnings
              </div>
              <div className="mt-1 font-mono text-[20px] font-bold text-ink">
                {formatCurrency(todayEarnings.data.total)}
              </div>
            </div>
            <DollarSign size={24} className="text-ok" />
          </div>
          {todayEarnings.data.trips.length > 0 && (
            <div className="mt-2 border-t border-border pt-2 space-y-1">
              {todayEarnings.data.trips.map((t: any) => (
                <div key={t.trip_id} className="flex items-center justify-between text-[11px]">
                  <span className="font-mono text-ink-secondary">{t.trip_no || `Trip #${t.trip_id}`}</span>
                  <span className="font-mono font-semibold text-ink">{formatCurrency(t.trip_allowance + t.ot_amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab strip */}
      <div className="mb-4 border-b border-border">
        <div className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0 [&>*]:shrink-0">
          {((CLOCK_ENABLED ? ["profile", "salary", "clock"] : ["profile", "salary"]) as Array<"profile" | "salary" | "clock">).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[12px] font-semibold capitalize",
                tab === t ? "border-accent text-accent" : "border-transparent text-ink-secondary"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "profile" && <ProfileTab profile={profile.data} onUpdated={() => profile.reload()} />}
      {tab === "salary" && <SalaryTab />}
      {CLOCK_ENABLED && tab === "clock" && <ClockHistoryTab />}

      <button
        onClick={() => logout()}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-err/60 bg-err/5 py-3 text-[13px] font-bold uppercase tracking-wide text-err"
      >
        <LogOut size={15} /> Sign out
      </button>
    </div>
  );
}

// ── Clock in/out card ─────────────────────────────────────────────

function ClockCard({
  clocked,
  isClockedIn,
  onReload,
}: {
  clocked: any;
  isClockedIn: boolean;
  onReload: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      if (isClockedIn) {
        await api.post("/api/fleet/clock/out");
      } else {
        await api.post("/api/fleet/clock/in");
      }
      onReload();
    } catch (e: any) {
      toast.error(e?.message || "Clock failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
            Clock
          </div>
          <div className="mt-1 text-[14px] font-bold text-ink">
            {isClockedIn
              ? `Clocked in at ${clocked?.clock_in?.slice(11, 16) || "—"}`
              : clocked?.clock_out
              ? `Clocked out · ${clocked.total_hours?.toFixed(1) || "—"}h`
              : "Not clocked in"}
          </div>
          {clocked?.fatigue_alert ? (
            <div className="mt-1 text-[11px] font-semibold text-err">
              Fatigue alert — exceeded maximum continuous hours
            </div>
          ) : null}
        </div>
        <button
          disabled={busy}
          onClick={toggle}
          className={cn(
            "rounded-lg px-5 py-2.5 text-[12px] font-bold uppercase tracking-wide disabled:opacity-50",
            isClockedIn
              ? "bg-err/10 text-err border border-err/30"
              : "bg-ok text-white"
          )}
        >
          <Clock size={14} className="mr-1.5 inline" />
          {busy ? "…" : isClockedIn ? "Clock Out" : "Clock In"}
        </button>
      </div>
    </div>
  );
}

// ── Profile tab ───────────────────────────────────────────────────

function ProfileTab({ profile, onUpdated }: { profile: any; onUpdated: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    phone: "",
    emergency_contact_name: "",
    emergency_contact_phone: "",
  });
  const [busy, setBusy] = useState(false);

  function startEdit() {
    setForm({
      phone: profile?.phone || "",
      emergency_contact_name: profile?.emergency_contact_name || "",
      emergency_contact_phone: profile?.emergency_contact_phone || "",
    });
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    try {
      await api.patch("/api/fleet/me", form);
      setEditing(false);
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <div className="text-sm text-ink-secondary">Loading…</div>;

  return (
    <div>
      <div className="rounded-xl border border-border bg-surface divide-y divide-border">
        <Field label="Email" value={profile.email} />
        {!editing ? (
          <>
            <Field label="Phone" value={profile.phone} />
            <Field label="IC" value={profile.ic_number} />
            {profile.user_type === "driver" && (
              <>
                <Field label="License" value={profile.license_no} />
                <Field label="License Expiry" value={formatDate(profile.license_expiry)} />
              </>
            )}
            <Field label="Emergency Contact" value={profile.emergency_contact_name} />
            <Field label="Emergency Phone" value={profile.emergency_contact_phone} />
          </>
        ) : (
          <div className="space-y-3 p-4">
            <EditableField label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} type="tel" />
            <div className="rounded-md bg-paper p-3">
              <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary mb-1">IC</div>
              <div className="text-[13px] text-ink-secondary">{profile.ic_number || "—"}</div>
            </div>
            {profile.user_type === "driver" && (
              <div className="rounded-md bg-paper p-3">
                <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary mb-1">License</div>
                <div className="text-[13px] text-ink-secondary">{profile.license_no || "—"} · Exp. {formatDate(profile.license_expiry)}</div>
              </div>
            )}
            <EditableField label="Emergency Contact Name" value={form.emergency_contact_name} onChange={(v) => setForm({ ...form, emergency_contact_name: v })} />
            <EditableField label="Emergency Contact Phone" value={form.emergency_contact_phone} onChange={(v) => setForm({ ...form, emergency_contact_phone: v })} type="tel" />
          </div>
        )}
      </div>

      <div className="mt-3">
        {!editing ? (
          <button
            onClick={startEdit}
            className="w-full rounded-md border border-border bg-surface py-2.5 text-[12px] font-semibold text-ink"
          >
            Edit Profile
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(false)}
              className="flex-1 rounded-md border border-border bg-surface py-2.5 text-[12px] font-semibold text-ink"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={save}
              className="flex-1 rounded-md bg-accent py-2.5 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EditableField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-paper px-3 py-2.5 text-[13px]"
      />
    </label>
  );
}

// ── Salary tab ────────────────────────────────────────────────────

function SalaryTab() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const salary = useQuery<any>(
    () => api.get(`/api/fleet/salary?period=${period}`),
    [period]
  );
  const s = salary.data;

  return (
    <div>
      <div className="mb-3">
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
        />
      </div>

      {salary.loading && <div className="text-sm text-ink-secondary">Loading…</div>}

      {s && (
        <>
          <div className="mb-4 rounded-xl border border-border bg-surface p-4">
            <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
              {s.period} Summary
            </div>
            <div className="mt-2 space-y-2">
              <SalaryRow label="Base Pay" amount={s.base_pay} />
              <SalaryRow label={`Trip Allowance (${s.trip_count} trips)`} amount={s.trip_allowance_total} />
              <SalaryRow label={`OT (${s.ot_hours.toFixed(1)}h)`} amount={s.ot_amount} />
              <div className="border-t border-border pt-2">
                <SalaryRow label="Gross" amount={s.gross} bold />
              </div>
              {s.deductions_total > 0 && (
                <SalaryRow label="Deductions" amount={-s.deductions_total} />
              )}
              <div className="border-t border-border pt-2">
                <SalaryRow label="Net" amount={s.net} bold />
              </div>
            </div>
          </div>

          {s.lines.length > 0 && (
            <div className="rounded-xl border border-border bg-surface">
              <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                Trip Breakdown
              </div>
              {s.lines.map((l: any) => (
                <div key={l.trip_id} className="flex items-center justify-between border-t border-border px-4 py-2">
                  <div>
                    <div className="font-mono text-[11px] font-semibold text-ink">
                      {l.trip_no || `Trip #${l.trip_id}`}
                    </div>
                    <div className="text-[10px] text-ink-secondary">{formatDate(l.trip_date)}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[12px] font-bold text-ink">
                      {formatCurrency(l.trip_allowance + l.ot_amount)}
                    </div>
                    {l.ot_hours > 0 && (
                      <div className="text-[10px] text-ink-secondary">+{l.ot_hours.toFixed(1)}h OT</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SalaryRow({ label, amount, bold }: { label: string; amount: number; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-[12px]", bold ? "font-bold text-ink" : "text-ink-secondary")}>
        {label}
      </span>
      <span className={cn("font-mono text-[13px]", bold ? "font-bold text-ink" : "text-ink")}>
        {formatCurrency(amount)}
      </span>
    </div>
  );
}

// ── Clock history tab ─────────────────────────────────────────────

function ClockHistoryTab() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const records = useQuery<{ data: any[] }>(
    () => api.get(`/api/fleet/clock/history?month=${month}`),
    [month]
  );

  return (
    <div>
      <div className="mb-3">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
        />
      </div>

      {records.loading && <div className="text-sm text-ink-secondary">Loading…</div>}

      <div className="rounded-xl border border-border bg-surface divide-y divide-border">
        {(records.data?.data ?? []).map((r: any) => (
          <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
            <div>
              <div className="text-[12px] font-semibold text-ink">{formatDate(r.clock_date)}</div>
              <div className="text-[11px] text-ink-secondary">
                {r.clock_in?.slice(11, 16)} → {r.clock_out?.slice(11, 16) || "—"}
              </div>
            </div>
            <div className="text-right">
              <div className={cn("font-mono text-[12px] font-bold", r.fatigue_alert ? "text-err" : "text-ink")}>
                {r.total_hours ? `${r.total_hours.toFixed(1)}h` : "—"}
              </div>
              {r.is_overtime ? (
                <div className="text-[10px] font-semibold text-warning-text">OT</div>
              ) : null}
            </div>
          </div>
        ))}
        {!records.loading && !(records.data?.data ?? []).length && (
          <div className="px-4 py-6 text-center text-[12px] text-ink-secondary">No records</div>
        )}
      </div>
    </div>
  );
}

// ── Field component ───────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
        {label}
      </span>
      <span className="text-[13px] font-medium text-ink">{value || "—"}</span>
    </div>
  );
}
