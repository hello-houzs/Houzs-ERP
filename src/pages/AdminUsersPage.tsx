// /admin/users — invite, manage, and impersonate team members.
// Admin-only (wrapped in AdminRoute at the App level).

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, Search, Loader2, UserPlus, Mail, Send, RotateCw, UserCog,
  Ban, CheckCircle2, Trash2, X, ChevronDown, Clock, ShieldAlert,
} from "lucide-react";
import { usersApi, type UserRow, type InvitePayload } from "@/lib/auth-api";
import { impersonate, useAuth } from "@/lib/auth-store";
import { BRANDS } from "@/lib/mock-data";

const POSITIONS = ["Sales Director", "Sales Manager", "Sales Executive", "Sales Trainee"];
const STATUSES: UserRow["status"][] = ["ACTIVE", "PENDING", "INACTIVE"];

export default function AdminUsersPage() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [posFilter, setPosFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showInvite, setShowInvite] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const nav = useNavigate();

  async function load() {
    const r = await usersApi.list();
    if (!r.ok) return setErr(r.error);
    setRows(r.data);
  }
  useEffect(() => { load(); }, []);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  const filtered = useMemo(() => {
    if (!rows) return [];
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (posFilter !== "all" && r.position !== posFilter) return false;
      // Derive "PENDING" for display: status ACTIVE + never logged in + has invite not used
      const displayStatus = derivePendingStatus(r);
      if (statusFilter !== "all" && displayStatus !== statusFilter) return false;
      if (!ql) return true;
      return (
        r.name.toLowerCase().includes(ql) ||
        r.email.toLowerCase().includes(ql) ||
        r.code.toLowerCase().includes(ql)
      );
    });
  }, [rows, q, posFilter, statusFilter]);

  async function handleInvite(payload: InvitePayload) {
    const r = await usersApi.invite(payload);
    if (!r.ok) return { ok: false as const, error: r.error };
    flash(r.data.emailSent ? `Invite sent to ${payload.email}` : `User created (email failed — resend manually)`);
    await load();
    return { ok: true as const };
  }

  async function handleResend(id: string) {
    const r = await usersApi.resendInvite(id);
    if (!r.ok) return flash(`Resend failed: ${r.error}`);
    flash(r.data.emailSent ? "Invite resent" : "User reset (email failed)");
    await load();
  }

  async function handleDisableEnable(row: UserRow) {
    const next: UserRow["status"] = row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const r = await usersApi.update(row.id, { status: next });
    if (!r.ok) return flash(r.error);
    flash(next === "INACTIVE" ? "User disabled" : "User enabled");
    await load();
  }

  async function handleDelete(row: UserRow) {
    if (!confirm(`Delete ${row.name} (${row.email})? This cannot be undone.`)) return;
    const r = await usersApi.remove(row.id);
    if (!r.ok) return flash(r.error);
    flash("User deleted");
    await load();
  }

  async function handleImpersonate(row: UserRow) {
    if (row.id === me?.id) return;
    const r = await impersonate(row.id);
    if (!r.ok) return flash(r.error);
    nav("/", { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[18px] font-bold text-[#0A1F2E]">Users</h1>
          <p className="text-[11px] text-gray-500">
            Invite team members, manage roles, and verify account setup.
          </p>
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0d6660]"
        >
          <Plus className="h-3.5 w-3.5" /> Invite user
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name / email / code"
            className="h-8 pl-8 pr-3 w-64 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
          />
        </div>
        <select
          value={posFilter}
          onChange={(e) => setPosFilter(e.target.value)}
          className="h-8 px-2 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
        >
          <option value="all">All positions</option>
          {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 px-2 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="ml-auto text-[11px] text-gray-500">
          {rows == null ? "Loading…" : `${filtered.length} of ${rows.length}`}
        </span>
      </div>

      {err && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-[12px] text-red-700 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" /> {err}
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-[#E5E7EB] rounded overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-[#F9FAFB] border-b border-[#E5E7EB] text-[10px] uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2 text-left font-semibold">Name</th>
              <th className="px-3 py-2 text-left font-semibold">Email</th>
              <th className="px-3 py-2 text-left font-semibold">Position</th>
              <th className="px-3 py-2 text-left font-semibold">Upline</th>
              <th className="px-3 py-2 text-left font-semibold">Status</th>
              <th className="px-3 py-2 text-left font-semibold">Last login</th>
              <th className="px-3 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows == null && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                <Loader2 className="inline h-4 w-4 animate-spin" />
              </td></tr>
            )}
            {rows && filtered.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-500">No users match those filters.</td></tr>
            )}
            {filtered.map((row) => {
              const upline = rows?.find((r) => r.id === row.parentId);
              const displayStatus = derivePendingStatus(row);
              const isMe = row.id === me?.id;
              return (
                <tr key={row.id} className="border-b border-[#F0F1F3] hover:bg-[#F9FAFB]">
                  <td className="px-3 py-2">
                    <div className="font-semibold text-[#0A1F2E]">{row.name}</div>
                    <div className="text-[10px] text-gray-500">{row.code || row.id}</div>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{row.email}</td>
                  <td className="px-3 py-2 text-gray-700">{row.position}</td>
                  <td className="px-3 py-2 text-gray-500">{upline?.name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={displayStatus} expiresAt={row.inviteExpiresAt} />
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {row.lastLogin ? new Date(row.lastLogin).toLocaleString() : <span className="text-gray-400">Never</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {displayStatus === "PENDING" && (
                        <IconBtn
                          title="Resend invite"
                          onClick={() => handleResend(row.id)}
                          icon={<RotateCw className="h-3.5 w-3.5" />}
                        />
                      )}
                      {!isMe && row.status === "ACTIVE" && row.hasPassword && (
                        <IconBtn
                          title="Login as this user"
                          onClick={() => handleImpersonate(row)}
                          icon={<UserCog className="h-3.5 w-3.5" />}
                        />
                      )}
                      <IconBtn
                        title="Edit"
                        onClick={() => setEditing(row)}
                        icon={<ChevronDown className="h-3.5 w-3.5" />}
                      />
                      {!isMe && (
                        <IconBtn
                          title={row.status === "ACTIVE" ? "Disable" : "Enable"}
                          onClick={() => handleDisableEnable(row)}
                          icon={row.status === "ACTIVE" ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                          intent={row.status === "ACTIVE" ? "warn" : "ok"}
                        />
                      )}
                      {!isMe && (
                        <IconBtn
                          title="Delete"
                          onClick={() => handleDelete(row)}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          intent="danger"
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          users={rows ?? []}
          onInvite={handleInvite}
        />
      )}

      {editing && (
        <EditModal
          row={editing}
          users={rows ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); flash("Saved"); }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 rounded bg-[#0A1F2E] text-white text-[11px] px-3 py-2 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Derive display status ───────────────────────────────────────────────────
// A user with status=ACTIVE but mustChangePassword=1 and never-logged-in is
// effectively "PENDING" — show that in the UI even though backend stores them
// as ACTIVE (so they can log in with temp password).
function derivePendingStatus(r: UserRow): "ACTIVE" | "PENDING" | "INACTIVE" {
  if (r.status === "INACTIVE") return "INACTIVE";
  if (r.mustChangePassword && !r.lastLogin) return "PENDING";
  return "ACTIVE";
}

// ─── UI bits ─────────────────────────────────────────────────────────────────

function StatusBadge({ status, expiresAt }: { status: "ACTIVE" | "PENDING" | "INACTIVE"; expiresAt: string | null }) {
  const cls = status === "ACTIVE"   ? "bg-emerald-100 text-emerald-700"
           : status === "PENDING"  ? "bg-amber-100 text-amber-700"
                                   : "bg-gray-200 text-gray-600";
  return (
    <div>
      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
        {status}
      </span>
      {status === "PENDING" && expiresAt && (
        <div className="text-[9px] text-gray-500 mt-0.5 inline-flex items-center gap-1 ml-1.5">
          <Clock className="h-2.5 w-2.5" /> {formatExpiry(expiresAt)}
        </div>
      )}
    </div>
  );
}

function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return `expires in ${days}d ${hours}h`;
  return `expires in ${hours}h`;
}

function IconBtn({ title, onClick, icon, intent }: {
  title: string; onClick: () => void; icon: React.ReactNode;
  intent?: "danger" | "warn" | "ok";
}) {
  const tone = intent === "danger" ? "hover:text-red-600"
             : intent === "warn"   ? "hover:text-amber-600"
             : intent === "ok"     ? "hover:text-emerald-600"
                                    : "hover:text-[#0F766E]";
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded p-1 text-gray-500 hover:bg-gray-100 transition ${tone}`}
    >
      {icon}
    </button>
  );
}

// ─── Invite modal ────────────────────────────────────────────────────────────

function InviteModal({ onClose, users, onInvite }: {
  onClose: () => void;
  users: UserRow[];
  onInvite: (p: InvitePayload) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [position, setPosition] = useState("Sales Executive");
  const [parentId, setParentId] = useState("");
  const [brands, setBrands] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const r = await onInvite({ name: name.trim(), email: email.trim().toLowerCase(), phone, position, parentId, assignedBrands: brands });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onClose();
  }

  const directors = users.filter((u) => ["Sales Director", "Sales Manager"].includes(u.position));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-[520px] bg-white rounded-lg shadow-xl border border-[#E5E7EB]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E5E7EB]">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-[#0F766E]" />
            <h2 className="text-[14px] font-bold text-[#0A1F2E]">Invite new user</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-3">
          <Field label="Name" required>
            <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
              className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
              placeholder="e.g. JOHN DOE" autoFocus />
          </Field>
          <Field label="Email" required>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
              placeholder="e.g. john@example.com" />
          </Field>
          <Field label="Phone">
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
              placeholder="+60" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Position">
              <select value={position} onChange={(e) => setPosition(e.target.value)}
                className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Upline">
              <select value={parentId} onChange={(e) => setParentId(e.target.value)}
                className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                <option value="">— None —</option>
                {directors.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.position})</option>)}
              </select>
            </Field>
          </div>
          <Field label="Assigned brands (optional)">
            <div className="flex flex-wrap gap-1.5">
              {BRANDS.map((b) => {
                const on = brands.includes(b);
                return (
                  <button type="button" key={b}
                    onClick={() => setBrands((prev) => on ? prev.filter((x) => x !== b) : [...prev, b])}
                    className={`text-[10px] px-2 py-0.5 rounded border ${on ? "bg-[#0F766E] border-[#0F766E] text-white" : "bg-white border-[#E5E7EB] text-gray-600"}`}>
                    {b}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="rounded border border-[#E5E7EB] bg-[#F9FAFB] p-3 text-[11px] text-gray-600">
            <div className="flex items-start gap-2">
              <Mail className="h-3.5 w-3.5 text-[#0F766E] mt-0.5" />
              <div>
                A random temp password will be emailed to <b>{email || "them"}</b>.
                The invite link expires in <b>7 days</b>. They'll be forced to set their
                own password on first login.
              </div>
            </div>
          </div>

          {err && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{err}</div>}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="h-8 px-3 rounded border border-[#E5E7EB] text-[11px] font-semibold text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="h-8 px-3 rounded bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0d6660] disabled:opacity-60 inline-flex items-center gap-1.5">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send invite
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Edit modal ──────────────────────────────────────────────────────────────

function EditModal({ row, users, onClose, onSaved }: {
  row: UserRow; users: UserRow[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(row.name);
  const [phone, setPhone] = useState(row.phone ?? "");
  const [position, setPosition] = useState(row.position);
  const [parentId, setParentId] = useState(row.parentId ?? "");
  const [brands, setBrands] = useState<string[]>(row.assignedBrands);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const r = await usersApi.update(row.id, { name, phone, position, parentId, assignedBrands: brands });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onSaved();
  }

  const candidates = users.filter((u) => u.id !== row.id && ["Sales Director", "Sales Manager"].includes(u.position));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-[520px] bg-white rounded-lg shadow-xl border border-[#E5E7EB]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E5E7EB]">
          <h2 className="text-[14px] font-bold text-[#0A1F2E]">Edit {row.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          <Field label="Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]" />
          </Field>
          <Field label="Email (cannot change)">
            <input type="text" value={row.email} disabled
              className="w-full h-8 px-2 text-[12px] bg-gray-50 border border-[#E5E7EB] rounded text-gray-500" />
          </Field>
          <Field label="Phone">
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Position">
              <select value={position} onChange={(e) => setPosition(e.target.value)}
                className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Upline">
              <select value={parentId} onChange={(e) => setParentId(e.target.value)}
                className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                <option value="">— None —</option>
                {candidates.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.position})</option>)}
              </select>
            </Field>
          </div>
          <Field label="Assigned brands">
            <div className="flex flex-wrap gap-1.5">
              {BRANDS.map((b) => {
                const on = brands.includes(b);
                return (
                  <button type="button" key={b}
                    onClick={() => setBrands((prev) => on ? prev.filter((x) => x !== b) : [...prev, b])}
                    className={`text-[10px] px-2 py-0.5 rounded border ${on ? "bg-[#0F766E] border-[#0F766E] text-white" : "bg-white border-[#E5E7EB] text-gray-600"}`}>
                    {b}
                  </button>
                );
              })}
            </div>
          </Field>
          {err && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{err}</div>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="h-8 px-3 rounded border border-[#E5E7EB] text-[11px] font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={busy}
              className="h-8 px-3 rounded bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0d6660] disabled:opacity-60 inline-flex items-center gap-1.5">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}
