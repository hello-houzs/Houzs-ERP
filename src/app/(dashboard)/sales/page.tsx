"use client";

import { useMemo, useState } from "react";
import {
  Users, Plus, Trash2, ChevronDown, ChevronRight, Search, X,
  Phone, UserPlus, Edit2, Check, Crown, Shield, User as UserIcon,
} from "lucide-react";
import {
  useSalesMembers, addMember, updateMember, removeMember, resetSalesMembers,
  buildTree, flattenTree,
  type SalesMember, type MemberRole, type MemberStatus, type MemberNode,
} from "@/lib/sales-store";

const ROLES: MemberRole[] = ["PIC", "LEADER", "MEMBER"];
const STATUSES: MemberStatus[] = ["ACTIVE", "INACTIVE"];

const ROLE_CONFIG: Record<MemberRole, { label: string; color: string; bg: string; icon: typeof Crown }> = {
  PIC:    { label: "PIC",    color: "text-amber-700",  bg: "bg-amber-100 border-amber-200",  icon: Crown },
  LEADER: { label: "Leader", color: "text-blue-700",   bg: "bg-blue-100 border-blue-200",    icon: Shield },
  MEMBER: { label: "Member", color: "text-gray-600",   bg: "bg-gray-100 border-gray-200",    icon: UserIcon },
};

const fieldLabel = "text-[9px] font-semibold uppercase tracking-wider text-gray-400";
const fieldInput =
  "w-full h-8 rounded-md border border-[#DDE5E5] px-2 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]";
const fieldSelect = fieldInput + " appearance-none cursor-pointer";
const selectClass =
  "h-8 rounded-md border border-[#DDE5E5] bg-white pl-2.5 pr-7 text-[11px] font-semibold text-gray-600 appearance-none cursor-pointer hover:border-[#0F766E] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] bg-no-repeat bg-[right_0.5rem_center] bg-[length:10px] bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%236b7280%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22M6%209l6%206%206-6%22%2F%3E%3C%2Fsvg%3E')]";

function RoleBadge({ role }: { role: MemberRole }) {
  const cfg = ROLE_CONFIG[role];
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${cfg.bg} ${cfg.color}`}>
      <Icon className="h-2.5 w-2.5" />
      {cfg.label}
    </span>
  );
}

function StatusDot({ status }: { status: MemberStatus }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${
      status === "ACTIVE" ? "bg-emerald-500" : "bg-gray-300"
    }`} title={status} />
  );
}

// ─── Add Member Dialog ───────────────────────────────────────────────────────

function AddMemberForm({
  members,
  onClose,
}: {
  members: SalesMember[];
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [ic, setIc] = useState("");
  const [role, setRole] = useState<MemberRole>("MEMBER");
  const [parentId, setParentId] = useState("");
  const [joinDate, setJoinDate] = useState(new Date().toISOString().slice(0, 10));

  // Parent candidates: PICs and Leaders
  const parentCandidates = members.filter(
    (m) => m.status === "ACTIVE" && (m.role === "PIC" || m.role === "LEADER")
  );

  function submit() {
    const n = name.trim().toUpperCase();
    if (!n) return;
    addMember({
      name: n,
      phone: phone.trim(),
      ic: ic.trim() || undefined,
      role,
      parentId: role === "PIC" ? "" : parentId,
      joinDate,
      status: "ACTIVE",
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        className="bg-white rounded-lg border border-[#DDE5E5] shadow-xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-[#0A1F2E]">
            <UserPlus className="h-4 w-4 inline mr-1.5 -mt-0.5 text-[#0F766E]" />
            Register New Member
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="h-6 w-6 rounded hover:bg-gray-200 inline-flex items-center justify-center text-gray-400 hover:text-gray-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <div className={fieldLabel}>Name *</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. ALI BIN AHMAD"
                className={fieldInput}
                autoFocus
              />
            </div>
            <div>
              <div className={fieldLabel}>Phone</div>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="012-345 6789"
                className={fieldInput}
              />
            </div>
            <div>
              <div className={fieldLabel}>IC No. (optional)</div>
              <input
                value={ic}
                onChange={(e) => setIc(e.target.value)}
                placeholder="880101-10-1234"
                className={fieldInput}
              />
            </div>
            <div>
              <div className={fieldLabel}>Role</div>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as MemberRole)}
                className={fieldSelect}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_CONFIG[r].label}</option>
                ))}
              </select>
            </div>
            <div>
              <div className={fieldLabel}>Join Date</div>
              <input
                type="date"
                value={joinDate}
                onChange={(e) => setJoinDate(e.target.value)}
                className={fieldInput}
              />
            </div>
            {role !== "PIC" && (
              <div className="col-span-2">
                <div className={fieldLabel}>Report to (Upline)</div>
                <select
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                  className={fieldSelect}
                >
                  <option value="">— Select upline —</option>
                  {parentCandidates.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({ROLE_CONFIG[m.role].label})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[#DDE5E5] flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!name.trim()}
            className="h-8 px-4 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Register
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Inline ─────────────────────────────────────────────────────────────

function EditRow({
  member,
  members,
  onClose,
}: {
  member: SalesMember;
  members: SalesMember[];
  onClose: () => void;
}) {
  const [name, setName] = useState(member.name);
  const [phone, setPhone] = useState(member.phone);
  const [ic, setIc] = useState(member.ic ?? "");
  const [role, setRole] = useState(member.role);
  const [parentId, setParentId] = useState(member.parentId);
  const [status, setStatus] = useState(member.status);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const parentCandidates = members.filter(
    (m) => m.status === "ACTIVE" && m.id !== member.id && (m.role === "PIC" || m.role === "LEADER")
  );

  function save() {
    updateMember(member.id, {
      name: name.trim().toUpperCase(),
      phone: phone.trim(),
      ic: ic.trim() || undefined,
      role,
      parentId: role === "PIC" ? "" : parentId,
      status,
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg border border-[#DDE5E5] shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-[#0A1F2E]">
            <Edit2 className="h-4 w-4 inline mr-1.5 -mt-0.5 text-[#0F766E]" />
            Edit: {member.name}
          </h3>
          <button type="button" onClick={onClose} className="h-6 w-6 rounded hover:bg-gray-200 inline-flex items-center justify-center text-gray-400 hover:text-gray-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <div className={fieldLabel}>Name</div>
              <input value={name} onChange={(e) => setName(e.target.value)} className={fieldInput} />
            </div>
            <div>
              <div className={fieldLabel}>Phone</div>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className={fieldInput} />
            </div>
            <div>
              <div className={fieldLabel}>IC No.</div>
              <input value={ic} onChange={(e) => setIc(e.target.value)} className={fieldInput} />
            </div>
            <div>
              <div className={fieldLabel}>Role</div>
              <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)} className={fieldSelect}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_CONFIG[r].label}</option>)}
              </select>
            </div>
            <div>
              <div className={fieldLabel}>Status</div>
              <select value={status} onChange={(e) => setStatus(e.target.value as MemberStatus)} className={fieldSelect}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {role !== "PIC" && (
              <div className="col-span-2">
                <div className={fieldLabel}>Report to (Upline)</div>
                <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={fieldSelect}>
                  <option value="">— No upline —</option>
                  {parentCandidates.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} ({ROLE_CONFIG[m.role].label})</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[#DDE5E5] flex items-center justify-between gap-2">
          <div>
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="h-7 px-2 rounded border border-red-200 text-[10px] font-semibold text-red-600 hover:bg-red-50 inline-flex items-center gap-1"
              >
                <Trash2 className="h-3 w-3" /> Remove
              </button>
            ) : (
              <div className="flex gap-1.5 items-center">
                <span className="text-[10px] text-red-600">Sure?</span>
                <button
                  type="button"
                  onClick={() => { removeMember(member.id); onClose(); }}
                  className="h-7 px-2 rounded bg-red-600 text-white text-[10px] font-semibold hover:bg-red-700"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="h-7 px-2 rounded border border-[#DDE5E5] text-[10px] font-semibold text-gray-600"
                >
                  No
                </button>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600">Cancel</button>
            <button type="button" onClick={save} className="h-8 px-4 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1">
              <Check className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Org Chart Tree Row ──────────────────────────────────────────────────────

function TreeRow({
  node,
  collapsed,
  onToggle,
  onEdit,
}: {
  node: MemberNode;
  collapsed: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const m = node.member;
  const hasChildren = node.children.length > 0;
  const cfg = ROLE_CONFIG[m.role];

  return (
    <div
      className="flex items-center gap-2 py-2 px-4 hover:bg-[#FAFBFB] cursor-pointer border-b border-[#F0F3F3] last:border-b-0"
      style={{ paddingLeft: `${node.depth * 28 + 16}px` }}
      onClick={onEdit}
    >
      {/* Expand/collapse toggle */}
      <div className="w-4 shrink-0">
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className="h-4 w-4 rounded hover:bg-gray-200 inline-flex items-center justify-center text-gray-400"
          >
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-block h-px w-3 bg-[#DDE5E5] mt-[7px] ml-0.5" />
        )}
      </div>

      {/* Avatar circle */}
      <div className={`h-7 w-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold ${
        m.status === "INACTIVE" ? "bg-gray-200 text-gray-400" :
        m.role === "PIC" ? "bg-amber-100 text-amber-700" :
        m.role === "LEADER" ? "bg-blue-100 text-blue-700" :
        "bg-[#0F766E]/10 text-[#0F766E]"
      }`}>
        {m.name.charAt(0)}
      </div>

      {/* Name + phone */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-[12px] font-semibold truncate ${m.status === "INACTIVE" ? "text-gray-400 line-through" : "text-[#0A1F2E]"}`}>
            {m.name}
          </span>
          <StatusDot status={m.status} />
        </div>
        <div className="text-[9px] text-gray-500 inline-flex items-center gap-1 tabular-nums">
          <Phone className="h-2 w-2" />
          {m.phone || "—"}
        </div>
      </div>

      {/* Role badge */}
      <RoleBadge role={m.role} />

      {/* Team count */}
      {node.descendantCount > 0 && (
        <span className="text-[9px] font-semibold text-[#0F766E] bg-[#0F766E]/10 rounded px-1.5 py-0.5 tabular-nums shrink-0">
          {node.descendantCount} pax
        </span>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function SalesPage() {
  const members = useSalesMembers();
  const [showAdd, setShowAdd] = useState(false);
  const [editMember, setEditMember] = useState<SalesMember | null>(null);
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState<MemberRole | "ALL">("ALL");
  const [filterStatus, setFilterStatus] = useState<MemberStatus | "ALL">("ALL");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(members), [members]);
  const flat = useMemo(() => flattenTree(tree), [tree]);

  // Apply search + filters — if searching, show flat list; otherwise show tree
  const isFiltering = search.trim() !== "" || filterRole !== "ALL" || filterStatus !== "ALL";
  const q = search.trim().toUpperCase();

  const filteredFlat = useMemo(() => {
    if (!isFiltering) return flat;
    return flat.filter((n) => {
      const m = n.member;
      if (filterRole !== "ALL" && m.role !== filterRole) return false;
      if (filterStatus !== "ALL" && m.status !== filterStatus) return false;
      if (q) {
        const hay = [m.name, m.phone, m.ic ?? "", m.role].join(" ").toUpperCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [flat, isFiltering, filterRole, filterStatus, q]);

  // When showing tree (no filter), respect collapsed state
  const visibleNodes = useMemo(() => {
    if (isFiltering) return filteredFlat;
    const result: MemberNode[] = [];
    function walk(nodes: MemberNode[]) {
      for (const n of nodes) {
        result.push(n);
        if (!collapsedIds.has(n.member.id)) {
          walk(n.children);
        }
      }
    }
    walk(tree);
    return result;
  }, [tree, filteredFlat, isFiltering, collapsedIds]);

  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Stats
  const activeCount = members.filter((m) => m.status === "ACTIVE").length;
  const picCount = members.filter((m) => m.role === "PIC" && m.status === "ACTIVE").length;
  const leaderCount = members.filter((m) => m.role === "LEADER" && m.status === "ACTIVE").length;
  const memberCount = members.filter((m) => m.role === "MEMBER" && m.status === "ACTIVE").length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E]">Sales Team</h1>
          <p className="text-sm text-gray-500 mt-1 inline-flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" />
            Organisation chart, member registration &amp; team hierarchy
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="h-9 px-3.5 rounded-md bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5"
        >
          <UserPlus className="h-4 w-4" /> Register Member
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Active", value: activeCount, color: "text-[#0F766E]", bg: "bg-[#0F766E]/10" },
          { label: "PICs", value: picCount, color: "text-amber-700", bg: "bg-amber-100" },
          { label: "Leaders", value: leaderCount, color: "text-blue-700", bg: "bg-blue-100" },
          { label: "Members", value: memberCount, color: "text-gray-700", bg: "bg-gray-100" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-[#DDE5E5] bg-white px-4 py-3">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">{s.label}</div>
            <div className={`text-[20px] font-bold ${s.color} mt-0.5 tabular-nums`}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Search + filter bar */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white p-2.5 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, IC…"
            className="w-full h-8 pl-8 pr-8 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-[#0A1F2E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <select
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value as MemberRole | "ALL")}
          className={selectClass}
        >
          <option value="ALL">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_CONFIG[r].label}</option>)}
        </select>

        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as MemberStatus | "ALL")}
          className={selectClass}
        >
          <option value="ALL">All status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        {isFiltering && (
          <button
            type="button"
            onClick={() => { setSearch(""); setFilterRole("ALL"); setFilterStatus("ALL"); }}
            className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-red-300 hover:text-red-600 inline-flex items-center gap-1"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}

        <div className="ml-auto text-[10px] text-gray-500 tabular-nums">
          {visibleNodes.length} / {members.length} members
        </div>
      </div>

      {/* Org Chart Tree */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">
              {isFiltering ? "Search Results" : "Organisation Chart"}
            </h2>
            <p className="text-[10px] text-gray-500 mt-0.5">
              {isFiltering
                ? "Flat list — clear filters to see tree hierarchy"
                : "Click a member to edit · PIC → Leader → Member hierarchy"}
            </p>
          </div>
          <div className="flex gap-1.5">
            {!isFiltering && (
              <>
                <button
                  type="button"
                  onClick={() => setCollapsedIds(new Set())}
                  className="h-7 px-2 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E]"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  onClick={() => setCollapsedIds(new Set(members.map((m) => m.id)))}
                  className="h-7 px-2 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E]"
                >
                  Collapse all
                </button>
              </>
            )}
          </div>
        </div>

        {visibleNodes.length === 0 ? (
          <div className="p-8 text-center text-[11px] text-gray-400">
            {isFiltering ? "No members match your filters" : "No members yet — register your first team member above"}
          </div>
        ) : (
          <div>
            {visibleNodes.map((node) => (
              <TreeRow
                key={node.member.id}
                node={isFiltering ? { ...node, depth: 0, children: [] } : node}
                collapsed={collapsedIds.has(node.member.id)}
                onToggle={() => toggleCollapse(node.member.id)}
                onEdit={() => setEditMember(node.member)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-[10px] text-gray-500">
        <span className="font-semibold uppercase tracking-wider">Hierarchy:</span>
        <span className="inline-flex items-center gap-1.5">
          <Crown className="h-3 w-3 text-amber-600" /> PIC — top-level person in charge
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Shield className="h-3 w-3 text-blue-600" /> Leader — team lead under PIC
        </span>
        <span className="inline-flex items-center gap-1.5">
          <UserIcon className="h-3 w-3 text-gray-500" /> Member — sales team member
        </span>
      </div>

      {/* Dialogs */}
      {showAdd && <AddMemberForm members={members} onClose={() => setShowAdd(false)} />}
      {editMember && <EditRow member={editMember} members={members} onClose={() => setEditMember(null)} />}
    </div>
  );
}
