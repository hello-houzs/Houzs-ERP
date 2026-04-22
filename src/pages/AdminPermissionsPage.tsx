// /admin/permissions — Matrix editor for role_permissions.
// HQ/Super Admin only (wrapped in AdminRoute at the App level; the API also
// gates via requireAuth + position === "Super Admin").

import { useEffect, useMemo, useState } from "react";
import {
  Loader2, Save, RotateCcw, ShieldAlert, ShieldCheck,
} from "lucide-react";
import {
  permissionsApi, type PermissionRow,
} from "@/lib/auth-api";
import {
  MODULES, ROLES, type AccessLevel, type ModuleDef,
} from "@/lib/modules";
import { buildDefaultPermissionsMap } from "@/lib/permissions-defaults";

type Department = "SALES" | "OPERATION" | "HQ";
const DEPARTMENTS: Department[] = ["SALES", "OPERATION", "HQ"];
const DEPT_LABELS: Record<Department, string> = {
  SALES: "Sales",
  OPERATION: "Operation",
  HQ: "HQ",
};

const LEVELS: AccessLevel[] = ["NONE", "VIEW", "EDIT", "FULL"];
const LEVEL_LABELS: Record<AccessLevel, string> = {
  NONE: "None",
  VIEW: "View",
  EDIT: "Edit",
  FULL: "Full",
};
const LEVEL_DOT: Record<AccessLevel, string> = {
  NONE: "bg-gray-300",
  VIEW: "bg-blue-400",
  EDIT: "bg-amber-400",
  FULL: "bg-emerald-500",
};
const LEVEL_TEXT: Record<AccessLevel, string> = {
  NONE: "text-gray-400",
  VIEW: "text-blue-700",
  EDIT: "text-amber-700",
  FULL: "text-emerald-700",
};

// Group label — user-visible names for the module-group headers.
const GROUP_LABELS: Record<string, string> = {
  PROJECT_MANAGEMENT: "PROJECT MANAGEMENT",
  SALES: "SALES",
  QMS: "QMS",
  DEPARTMENTS: "DEPARTMENTS",
  ADMIN: "ADMIN",
};

function cellKey(dept: string, position: string, moduleKey: string): string {
  return `${dept}:${position}:${moduleKey}`;
}

/** Stable group order matches the source order of MODULES. */
function groupModules(mods: ModuleDef[]): { group: string; items: ModuleDef[] }[] {
  const out: { group: string; items: ModuleDef[] }[] = [];
  const seen = new Map<string, ModuleDef[]>();
  for (const m of mods) {
    if (!seen.has(m.group)) {
      const list: ModuleDef[] = [];
      seen.set(m.group, list);
      out.push({ group: m.group, items: list });
    }
    seen.get(m.group)!.push(m);
  }
  return out;
}

export default function AdminPermissionsPage() {
  const [levels, setLevels] = useState<Record<string, AccessLevel> | null>(null);
  const [dept, setDept] = useState<Department>("SALES");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function load() {
    setLoading(true);
    setErr(null);
    const r = await permissionsApi.list();
    setLoading(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    const map: Record<string, AccessLevel> = {};
    // Seed with NONE for every known role x module so missing DB rows still
    // render as an editable cell.
    for (const role of ROLES) {
      for (const mod of MODULES) {
        map[cellKey(role.department, role.position, mod.key)] = "NONE";
      }
    }
    for (const row of r.data) {
      map[cellKey(row.department, row.position, row.moduleKey)] = row.level;
    }
    setLevels(map);
    setDirty(false);
  }

  useEffect(() => { load(); }, []);

  // Roles scoped to the active department tab.
  const deptRoles = useMemo(() => ROLES.filter((r) => r.department === dept), [dept]);

  const groupedModules = useMemo(() => groupModules(MODULES), []);

  function setLevel(position: string, moduleKey: string, level: AccessLevel) {
    if (!levels) return;
    const key = cellKey(dept, position, moduleKey);
    if (levels[key] === level) return;
    const next = { ...levels, [key]: level };
    setLevels(next);
    setDirty(true);
  }

  function resetToDefaults() {
    if (!confirm("Reset every role's permissions to the system defaults? You still need to click Save to persist.")) return;
    setLevels(buildDefaultPermissionsMap());
    setDirty(true);
    flash("Defaults loaded — click Save to persist");
  }

  async function save() {
    if (!levels) return;
    setSaving(true);
    setErr(null);
    const rows: PermissionRow[] = [];
    for (const role of ROLES) {
      for (const mod of MODULES) {
        const level = levels[cellKey(role.department, role.position, mod.key)] ?? "NONE";
        rows.push({
          department: role.department,
          position: role.position,
          moduleKey: mod.key,
          level,
        });
      }
    }
    const r = await permissionsApi.save(rows);
    setSaving(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    flash(`Saved ${r.data.rowCount} permission row${r.data.rowCount === 1 ? "" : "s"}`);
    await load();
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-bold text-[#0A1F2E]">Permissions</h1>
          <p className="text-[11px] text-gray-500">
            Control which modules each role can access.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={resetToDefaults}
            disabled={loading || saving}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-[#E5E7EB] bg-white text-[11px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            title="Reset every cell to the system defaults (not yet saved)"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving || loading}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0d6660] disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-[12px] text-red-700 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" /> {err}
        </div>
      )}

      {/* Department tabs */}
      <div className="flex items-center gap-1 border-b border-[#E5E7EB]">
        {DEPARTMENTS.map((d) => {
          const active = d === dept;
          const count = ROLES.filter((r) => r.department === d).length;
          return (
            <button
              key={d}
              onClick={() => setDept(d)}
              className={
                "relative h-8 px-3 text-[11px] font-semibold transition " +
                (active
                  ? "text-[#0F766E] border-b-2 border-[#0F766E] -mb-px"
                  : "text-gray-500 hover:text-[#0A1F2E]")
              }
            >
              {DEPT_LABELS[d]}
              <span className="ml-1.5 text-[10px] text-gray-400 tabular-nums">{count}</span>
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-3 text-[10px] text-gray-500">
          <Legend />
          {dirty && !saving && (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Unsaved changes
            </span>
          )}
        </div>
      </div>

      {/* Matrix */}
      <div className="bg-white border border-[#E5E7EB] rounded overflow-hidden">
        {loading && (
          <div className="px-3 py-12 text-center text-gray-500 text-[11px]">
            <Loader2 className="inline h-4 w-4 animate-spin" />
          </div>
        )}
        {!loading && levels && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-[#F9FAFB] border-b border-[#E5E7EB] text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 text-left font-semibold sticky left-0 bg-[#F9FAFB] min-w-[240px]">
                    Module
                  </th>
                  {deptRoles.map((r) => (
                    <th key={r.position} className="px-3 py-2 text-left font-semibold whitespace-nowrap min-w-[140px]">
                      {r.position}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupedModules.map(({ group, items }) => (
                  <GroupSection
                    key={group}
                    group={group}
                    items={items}
                    deptRoles={deptRoles}
                    levels={levels}
                    dept={dept}
                    onChange={setLevel}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 rounded bg-[#0A1F2E] text-white text-[11px] px-3 py-2 shadow-lg inline-flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> {toast}
        </div>
      )}
    </div>
  );
}

function GroupSection({
  group, items, deptRoles, levels, dept, onChange,
}: {
  group: string;
  items: ModuleDef[];
  deptRoles: { department: Department; position: string }[];
  levels: Record<string, AccessLevel>;
  dept: Department;
  onChange: (position: string, moduleKey: string, level: AccessLevel) => void;
}) {
  return (
    <>
      <tr className="bg-[#F4F7F7] border-b border-[#E5E7EB]">
        <td
          colSpan={1 + deptRoles.length}
          className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#0A1F2E]"
        >
          {GROUP_LABELS[group] ?? group}
        </td>
      </tr>
      {items.map((mod) => (
        <tr key={mod.key} className="border-b border-[#F0F1F3] hover:bg-[#FAFBFC]">
          <td className="px-3 py-1.5 sticky left-0 bg-white">
            <div className="font-semibold text-[#0A1F2E]">{mod.label}</div>
            <div className="text-[10px] text-gray-400 font-mono">{mod.key}</div>
          </td>
          {deptRoles.map((r) => {
            const key = cellKey(dept, r.position, mod.key);
            const level = levels[key] ?? "NONE";
            return (
              <td key={r.position} className="px-2 py-1">
                <LevelSelect
                  value={level}
                  onChange={(v) => onChange(r.position, mod.key, v)}
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function LevelSelect({
  value, onChange,
}: { value: AccessLevel; onChange: (v: AccessLevel) => void }) {
  return (
    <div className="relative inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full shrink-0 ${LEVEL_DOT[value]}`} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as AccessLevel)}
        className={
          "h-7 pl-1.5 pr-6 rounded border border-[#E5E7EB] bg-white text-[11px] font-semibold appearance-none cursor-pointer focus:outline-none focus:border-[#0F766E] " +
          LEVEL_TEXT[value]
        }
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 0.35rem center",
          backgroundSize: "10px",
        }}
      >
        {LEVELS.map((lv) => (
          <option key={lv} value={lv}>{LEVEL_LABELS[lv]}</option>
        ))}
      </select>
    </div>
  );
}

function Legend() {
  return (
    <div className="inline-flex items-center gap-3">
      {LEVELS.map((lv) => (
        <span key={lv} className="inline-flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${LEVEL_DOT[lv]}`} />
          <span className={LEVEL_TEXT[lv]}>{LEVEL_LABELS[lv]}</span>
        </span>
      ))}
    </div>
  );
}
