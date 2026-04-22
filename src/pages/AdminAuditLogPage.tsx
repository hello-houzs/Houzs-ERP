// /admin/audit-log — read-only log of everything that happened in the system.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Filter, Download, ShieldAlert } from "lucide-react";
import { auditApi, type AuditEntry } from "@/lib/auth-api";

const ACTIONS = [
  "all", "login", "login_failed", "logout", "invite", "invite_resent",
  "impersonate_start", "impersonate_stop",
  "create", "update", "delete",
  "reset_password_requested", "reset_password",
];
const ENTITIES = ["all", "user", "sku", "so_header", "so_line", "payment", "fabric", "variants_config"];

export default function AdminAuditLogPage() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const [entity, setEntity] = useState("all");
  const [limit, setLimit] = useState(200);

  async function load() {
    const r = await auditApi.list({
      action: action === "all" ? "" : action,
      entity: entity === "all" ? "" : entity,
      limit,
    });
    if (!r.ok) return setErr(r.error);
    setRows(r.data);
  }
  useEffect(() => { load(); }, [action, entity, limit]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const ql = q.trim().toLowerCase();
    if (!ql) return rows;
    return rows.filter((r) => (
      (r.userName ?? "").toLowerCase().includes(ql) ||
      (r.entityId ?? "").toLowerCase().includes(ql) ||
      (r.field ?? "").toLowerCase().includes(ql) ||
      (r.action).toLowerCase().includes(ql)
    ));
  }, [rows, q]);

  function exportCsv() {
    if (!rows) return;
    const cols = ["timestamp", "userName", "userPosition", "action", "entityType", "entityId", "field", "oldValue", "newValue", "ipAddress"];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...filtered.map((r) => cols.map((c) => esc((r as unknown as Record<string, unknown>)[c])).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[18px] font-bold text-[#0A1F2E]">Audit Log</h1>
          <p className="text-[11px] text-gray-500">Who changed what, when — append-only history of system activity.</p>
        </div>
        <button onClick={exportCsv}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-[#E5E7EB] bg-white text-[11px] font-semibold text-gray-700 hover:bg-gray-50">
          <Download className="h-3.5 w-3.5" /> Export CSV
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search user / entity / field"
            className="h-8 pl-8 pr-3 w-64 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]" />
        </div>
        <select value={action} onChange={(e) => setAction(e.target.value)}
          className="h-8 px-2 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
          {ACTIONS.map((a) => <option key={a} value={a}>{a === "all" ? "All actions" : a}</option>)}
        </select>
        <select value={entity} onChange={(e) => setEntity(e.target.value)}
          className="h-8 px-2 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
          {ENTITIES.map((e) => <option key={e} value={e}>{e === "all" ? "All entities" : e}</option>)}
        </select>
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}
          className="h-8 px-2 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
          {[100, 200, 500, 1000].map((n) => <option key={n} value={n}>Last {n}</option>)}
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

      <div className="bg-white border border-[#E5E7EB] rounded overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-[#F9FAFB] border-b border-[#E5E7EB] text-[10px] uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2 text-left font-semibold w-40">Time</th>
              <th className="px-3 py-2 text-left font-semibold">User</th>
              <th className="px-3 py-2 text-left font-semibold">Action</th>
              <th className="px-3 py-2 text-left font-semibold">Entity</th>
              <th className="px-3 py-2 text-left font-semibold">Change</th>
              <th className="px-3 py-2 text-left font-semibold">IP</th>
            </tr>
          </thead>
          <tbody>
            {rows == null && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-500"><Loader2 className="inline h-4 w-4 animate-spin" /></td></tr>
            )}
            {rows && filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-500">No entries match these filters.</td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} className="border-b border-[#F0F1F3] hover:bg-[#F9FAFB] align-top">
                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatTs(r.timestamp)}</td>
                <td className="px-3 py-2">
                  {r.userName ? (
                    <div>
                      <div className="font-semibold text-[#0A1F2E]">{r.userName}</div>
                      <div className="text-[10px] text-gray-500">{r.userPosition}</div>
                    </div>
                  ) : <span className="text-gray-400">system / anon</span>}
                </td>
                <td className="px-3 py-2"><ActionBadge action={r.action} /></td>
                <td className="px-3 py-2 text-gray-600">
                  {r.entityType ? <code className="text-[10px] bg-gray-100 px-1 rounded">{r.entityType}</code> : null}
                  {r.entityId ? <span className="text-[11px] ml-1">{r.entityId}</span> : null}
                </td>
                <td className="px-3 py-2 text-gray-700">
                  <ChangeCell entry={r} />
                </td>
                <td className="px-3 py-2 text-gray-400 text-[10px] whitespace-nowrap">{r.ipAddress}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const color = action.startsWith("login_failed") ? "bg-red-100 text-red-700"
             : action === "delete"                ? "bg-red-100 text-red-700"
             : action === "create" || action === "invite" ? "bg-emerald-100 text-emerald-700"
             : action === "update"                ? "bg-blue-100 text-blue-700"
             : action.startsWith("impersonate")   ? "bg-amber-100 text-amber-700"
                                                   : "bg-gray-100 text-gray-700";
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${color}`}>{action}</span>;
}

function ChangeCell({ entry }: { entry: AuditEntry }) {
  if (entry.field) {
    return (
      <span>
        <code className="text-[10px] bg-gray-100 px-1 rounded">{entry.field}</code>:{" "}
        <span className="text-gray-400 line-through">{entry.oldValue ?? "—"}</span>{" "}
        → <span>{entry.newValue ?? "—"}</span>
      </span>
    );
  }
  if (entry.changes) {
    return (
      <details className="cursor-pointer">
        <summary className="text-[10px] text-[#0F766E]">{Object.keys(entry.changes).length} field(s)</summary>
        <pre className="mt-1 text-[10px] bg-gray-50 p-2 rounded border border-[#E5E7EB] max-w-md overflow-auto">{JSON.stringify(entry.changes, null, 2)}</pre>
      </details>
    );
  }
  return <span className="text-gray-400 text-[10px]">—</span>;
}

function formatTs(ts: string): string {
  const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
  return d.toLocaleString();
}
