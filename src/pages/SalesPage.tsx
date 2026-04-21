import React, { useMemo, useState } from "react";
import {
  Users, Plus, Trash2, ChevronDown, ChevronRight, Search, X,
  Phone, UserPlus, Edit2, Check, Crown, Shield, User as UserIcon,
  Mail, Tag, DollarSign, AlertTriangle, List, GitBranch, Settings,
} from "lucide-react";
import { BRANDS, type Brand } from "@/lib/mock-data";
import {
  useSalesMembers, addMember, updateMember, removeMember, resetSalesMembers,
  buildTree, flattenTree, readPositions, writePositions,
  readDefaultCommission, writeDefaultCommission, calcCommission, findCommissionRate,
  DEFAULT_POSITIONS, DEFAULT_COMMISSION,
  type SalesMember, type MemberStatus, type MemberNode,
  type CommissionTier,
} from "@/lib/sales-store";
import { FIELD_LABEL, FIELD_INPUT, FIELD_SELECT, FILTER_SELECT } from "@/lib/ui-tokens";

const STATUSES: MemberStatus[] = ["ACTIVE", "INACTIVE"];

const BRAND_DOT: Record<Brand, string> = {
  AKEMI: "bg-[#4F6BED]", ZANOTTI: "bg-[#7B5BD6]",
  ERGOTEX: "bg-[#1A73E8]", DUNLOPILLO: "bg-[#0B8043]",
};

function StatusDot({ status }: { status: MemberStatus }) {
  return <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${status === "ACTIVE" ? "bg-emerald-500" : "bg-gray-300"}`} title={status} />;
}

function PositionBadge({ position }: { position: string }) {
  const isDir = position.includes("Director");
  const isMgr = position.includes("Manager");
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${
      isDir ? "bg-amber-100 border-amber-200 text-amber-700" :
      isMgr ? "bg-blue-100 border-blue-200 text-blue-700" :
              "bg-gray-100 border-gray-200 text-gray-600"
    }`}>
      {isDir ? <Crown className="h-2.5 w-2.5" /> : isMgr ? <Shield className="h-2.5 w-2.5" /> : <UserIcon className="h-2.5 w-2.5" />}
      {position}
    </span>
  );
}

function RoleBadge({ position }: { position: string }) {
  const isDir = position.includes("Director");
  const isMgr = position.includes("Manager");
  if (isDir) return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-[#0F766E] text-white">
      <Crown className="h-2 w-2" /> ADMIN
    </span>
  );
  if (isMgr) return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-blue-600 text-white">
      <Shield className="h-2 w-2" /> MANAGER
    </span>
  );
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-gray-400 text-white">
      <UserIcon className="h-2 w-2" /> EXEC
    </span>
  );
}

function BrandDots({ brands }: { brands: Brand[] }) {
  if (brands.length === 0) return <span className="text-[9px] text-gray-300">&mdash;</span>;
  return (
    <div className="flex items-center gap-1">
      {brands.map((b) => (
        <span key={b} className={`h-4 px-1.5 rounded text-[8px] font-bold text-white inline-flex items-center ${BRAND_DOT[b]}`} title={b}>
          {b.slice(0, 3)}
        </span>
      ))}
    </div>
  );
}

function BrandDotsCompact({ brands }: { brands: Brand[] }) {
  if (brands.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5 justify-center">
      {brands.map((b) => (
        <span key={b} className={`h-2 w-2 rounded-full ${BRAND_DOT[b]}`} title={b} />
      ))}
    </div>
  );
}

function fmtRM(n: number) {
  return "RM " + n.toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ─── Add Member Dialog ───────────────────────────────────────────────────────

function AddMemberForm({ members, positions, onClose }: {
  members: SalesMember[]; positions: string[]; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [ic, setIc] = useState("");
  const [position, setPosition] = useState(positions[positions.length - 1] ?? "Sales Executive");
  const [parentId, setParentId] = useState("");
  const [joinDate, setJoinDate] = useState(new Date().toISOString().slice(0, 10));
  const [selectedBrands, setSelectedBrands] = useState<Brand[]>([]);

  const parentCandidates = members.filter((m) => m.status === "ACTIVE");

  function toggleBrand(b: Brand) {
    setSelectedBrands((prev) => prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]);
  }

  function submit() {
    const n = name.trim().toUpperCase();
    if (!n) return;
    addMember({
      name: n, code: code.trim() || n, phone: phone.trim(), email: email.trim(),
      ic: ic.trim() || undefined, position, parentId, joinDate,
      status: "ACTIVE", assignedBrands: selectedBrands, commissionTiers: [], minRate: 0,
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg border border-[#DDE5E5] shadow-xl w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between sticky top-0">
          <h3 className="text-[13px] font-semibold text-[#0A1F2E]">
            <UserPlus className="h-4 w-4 inline mr-1.5 -mt-0.5 text-[#0F766E]" />
            Register New Member
          </h3>
          <button type="button" onClick={onClose} className="h-6 w-6 rounded hover:bg-gray-200 inline-flex items-center justify-center text-gray-400 hover:text-gray-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={FIELD_LABEL}>Name *</div>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className={FIELD_INPUT} autoFocus />
            </div>
            <div>
              <div className={FIELD_LABEL}>Code / Alias</div>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Short code" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Phone</div>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+6012..." className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Email</div>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@..." className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>IC No.</div>
              <input value={ic} onChange={(e) => setIc(e.target.value)} placeholder="880101-10-1234" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Join Date</div>
              <input type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Position</div>
              <select value={position} onChange={(e) => setPosition(e.target.value)} className={FIELD_SELECT}>
                {positions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <div className={FIELD_LABEL}>Upline</div>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={FIELD_SELECT}>
                <option value="">— No upline (top level) —</option>
                {parentCandidates.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.position})</option>)}
              </select>
            </div>
          </div>
          <div>
            <div className={FIELD_LABEL}>Assigned Brands</div>
            <div className="flex gap-1.5 mt-1">
              {BRANDS.map((b) => (
                <button key={b} type="button" onClick={() => toggleBrand(b)}
                  className={`h-7 px-2.5 rounded border text-[10px] font-semibold transition ${
                    selectedBrands.includes(b)
                      ? `${BRAND_DOT[b]} text-white border-transparent`
                      : "bg-white text-gray-600 border-[#DDE5E5] hover:border-[#0F766E]"
                  }`}>
                  {b}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-[#DDE5E5] flex justify-end gap-2 sticky bottom-0 bg-white">
          <button type="button" onClick={onClose} className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600">Cancel</button>
          <button type="button" onClick={submit} disabled={!name.trim()} className="h-8 px-4 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] disabled:opacity-40 inline-flex items-center gap-1">
            <Plus className="h-3 w-3" /> Register
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Member Dialog ──────────────────────────────────────────────────────

function EditMemberDialog({ member, members, positions, onClose }: {
  member: SalesMember; members: SalesMember[]; positions: string[]; onClose: () => void;
}) {
  const [name, setName] = useState(member.name);
  const [code, setCode] = useState(member.code);
  const [phone, setPhone] = useState(member.phone);
  const [email, setEmail] = useState(member.email);
  const [ic, setIc] = useState(member.ic ?? "");
  const [position, setPosition] = useState(member.position);
  const [parentId, setParentId] = useState(member.parentId);
  const [status, setStatus] = useState(member.status);
  const [selectedBrands, setSelectedBrands] = useState<Brand[]>(member.assignedBrands);
  const [tiers, setTiers] = useState<CommissionTier[]>(member.commissionTiers);
  const [minRate, setMinRate] = useState(member.minRate ?? 0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<"info" | "commission">("info");

  const parentCandidates = members.filter((m) => m.status === "ACTIVE" && m.id !== member.id);
  const defaultTiers = readDefaultCommission();

  function toggleBrand(b: Brand) {
    setSelectedBrands((prev) => prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]);
  }

  function addTier() {
    const last = tiers.length > 0 ? tiers[tiers.length - 1] : null;
    setTiers([...tiers, {
      threshold: (last?.threshold ?? 0) + 100000,
      pct: (last?.pct ?? 0) + 1,
    }]);
  }

  function updateTier(i: number, patch: Partial<CommissionTier>) {
    setTiers((prev) => prev.map((t, idx) => idx === i ? { ...t, ...patch } : t));
  }

  function removeTier(i: number) {
    setTiers((prev) => prev.filter((_, idx) => idx !== i));
  }

  function save() {
    updateMember(member.id, {
      name: name.trim().toUpperCase(), code: code.trim(), phone: phone.trim(),
      email: email.trim(), ic: ic.trim() || undefined, position, parentId, status,
      assignedBrands: selectedBrands, commissionTiers: tiers, minRate,
    });
    onClose();
  }

  // Preview commission — team sales (personal + group) with cost/net
  const [previewPersonal, setPreviewPersonal] = useState(100000);
  const [previewGroup, setPreviewGroup] = useState(810000);
  const [previewDownlineCost, setPreviewDownlineCost] = useState(40500);
  const previewTeamTotal = previewPersonal + previewGroup;
  const effectiveTiers = tiers.length > 0 ? tiers : defaultTiers;
  const previewRate = findCommissionRate(previewTeamTotal, effectiveTiers, minRate);
  const previewGross = previewTeamTotal * (previewRate / 100);
  const previewNet = previewGross - previewDownlineCost;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg border border-[#DDE5E5] shadow-xl w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between shrink-0">
          <h3 className="text-[13px] font-semibold text-[#0A1F2E]">
            <Edit2 className="h-4 w-4 inline mr-1.5 -mt-0.5 text-[#0F766E]" />
            {member.name}
          </h3>
          <button type="button" onClick={onClose} className="h-6 w-6 rounded hover:bg-gray-200 inline-flex items-center justify-center text-gray-400 hover:text-gray-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#DDE5E5] shrink-0">
          {(["info", "commission"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`flex-1 py-2 text-[11px] font-semibold transition ${
                tab === t ? "text-[#0F766E] border-b-2 border-[#0F766E]" : "text-gray-400 hover:text-gray-600"
              }`}>
              {t === "info" ? "Profile & Brands" : "Commission"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "info" && (
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><div className={FIELD_LABEL}>Name</div><input value={name} onChange={(e) => setName(e.target.value)} className={FIELD_INPUT} /></div>
                <div><div className={FIELD_LABEL}>Code</div><input value={code} onChange={(e) => setCode(e.target.value)} className={FIELD_INPUT} /></div>
                <div><div className={FIELD_LABEL}>Phone</div><input value={phone} onChange={(e) => setPhone(e.target.value)} className={FIELD_INPUT} /></div>
                <div><div className={FIELD_LABEL}>Email</div><input value={email} onChange={(e) => setEmail(e.target.value)} className={FIELD_INPUT} /></div>
                <div><div className={FIELD_LABEL}>IC No.</div><input value={ic} onChange={(e) => setIc(e.target.value)} className={FIELD_INPUT} /></div>
                <div>
                  <div className={FIELD_LABEL}>Status</div>
                  <select value={status} onChange={(e) => setStatus(e.target.value as MemberStatus)} className={FIELD_SELECT}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <div className={FIELD_LABEL}>Position</div>
                  <select value={position} onChange={(e) => setPosition(e.target.value)} className={FIELD_SELECT}>
                    {positions.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <div className={FIELD_LABEL}>Upline</div>
                  <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={FIELD_SELECT}>
                    <option value="">— No upline —</option>
                    {parentCandidates.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.position})</option>)}
                  </select>
                </div>
              </div>
              <div>
                <div className={FIELD_LABEL}>Assigned Brands</div>
                <div className="flex gap-1.5 mt-1">
                  {BRANDS.map((b) => (
                    <button key={b} type="button" onClick={() => toggleBrand(b)}
                      className={`h-7 px-2.5 rounded border text-[10px] font-semibold transition ${
                        selectedBrands.includes(b)
                          ? `${BRAND_DOT[b]} text-white border-transparent`
                          : "bg-white text-gray-600 border-[#DDE5E5] hover:border-[#0F766E]"
                      }`}>{b}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === "commission" && (
            <div className="p-5 space-y-4">
              <div className="text-[10px] text-gray-500">
                {tiers.length === 0
                  ? "Using global default commission tiers. Add personal tiers to override."
                  : "Custom commission tiers for this member."}
              </div>

              {/* Min rate */}
              <div>
                <div className={FIELD_LABEL}>Minimum Commission Rate (%)</div>
                <div className="flex items-center gap-2">
                  <input type="number" step="0.5" value={minRate} onChange={(e) => setMinRate(Number(e.target.value))} className={FIELD_INPUT + " w-32"} />
                  <span className="text-[10px] text-gray-500">Personal floor rate — guaranteed minimum %</span>
                </div>
              </div>

              {/* Tier table — threshold-based */}
              <div className="rounded-md border border-[#DDE5E5] overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-[#F4F7F7] text-[9px] font-semibold uppercase tracking-wider text-gray-500">
                    <tr>
                      <th className="text-left px-3 py-1.5">Sales Threshold (RM)</th>
                      <th className="text-left px-3 py-1.5">Rate %</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0F3F3]">
                    {(tiers.length > 0 ? tiers : defaultTiers).map((t, i) => {
                      const isCustom = tiers.length > 0;
                      return (
                        <tr key={i} className={!isCustom ? "opacity-50" : ""}>
                          <td className="px-3 py-1.5">
                            {isCustom ? (
                              <input type="number" value={t.threshold} onChange={(e) => updateTier(i, { threshold: Number(e.target.value) })}
                                className="w-full h-6 rounded border border-[#DDE5E5] px-1.5 text-[11px] tabular-nums" />
                            ) : fmtRM(t.threshold)}
                          </td>
                          <td className="px-3 py-1.5">
                            {isCustom ? (
                              <input type="number" step="0.5" value={t.pct} onChange={(e) => updateTier(i, { pct: Number(e.target.value) })}
                                className="w-full h-6 rounded border border-[#DDE5E5] px-1.5 text-[11px] tabular-nums" />
                            ) : `${t.pct}%`}
                          </td>
                          <td className="px-1">
                            {isCustom && (
                              <button type="button" onClick={() => removeTier(i)} className="h-5 w-5 rounded hover:bg-red-50 inline-flex items-center justify-center text-gray-300 hover:text-red-500">
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex gap-2">
                <button type="button" onClick={addTier}
                  className="h-7 px-2.5 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-[#0F766E] hover:border-[#0F766E] inline-flex items-center gap-1">
                  <Plus className="h-3 w-3" /> Add tier
                </button>
                {tiers.length > 0 && (
                  <button type="button" onClick={() => setTiers([])}
                    className="h-7 px-2.5 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-gray-500 hover:text-red-600 hover:border-red-300">
                    Reset to default
                  </button>
                )}
              </div>

              {/* Preview — team sales calculator with gross/cost/net */}
              <div className="rounded-md border border-[#DDE5E5] bg-[#FAFBFB] p-3 space-y-2">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">Commission Calculator</div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-[9px] text-gray-400 mb-0.5">Personal Sales</div>
                    <input type="number" value={previewPersonal} onChange={(e) => setPreviewPersonal(Number(e.target.value))}
                      className="w-full h-7 rounded border border-[#DDE5E5] px-1.5 text-[11px] tabular-nums" />
                  </div>
                  <div>
                    <div className="text-[9px] text-gray-400 mb-0.5">Group Sales</div>
                    <input type="number" value={previewGroup} onChange={(e) => setPreviewGroup(Number(e.target.value))}
                      className="w-full h-7 rounded border border-[#DDE5E5] px-1.5 text-[11px] tabular-nums" />
                  </div>
                  <div>
                    <div className="text-[9px] text-gray-400 mb-0.5">Downline Cost</div>
                    <input type="number" value={previewDownlineCost} onChange={(e) => setPreviewDownlineCost(Number(e.target.value))}
                      className="w-full h-7 rounded border border-[#DDE5E5] px-1.5 text-[11px] tabular-nums" />
                  </div>
                </div>
                <div className="text-[11px] text-[#0A1F2E] pt-1 border-t border-[#DDE5E5] space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Team Total</span>
                    <span className="font-semibold tabular-nums">{fmtRM(previewTeamTotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Rate</span>
                    <span className="font-semibold tabular-nums">{previewRate}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Gross Commission</span>
                    <span className="font-semibold tabular-nums">{fmtRM(previewGross)}</span>
                  </div>
                  <div className="flex justify-between text-red-500">
                    <span>− Downline Cost</span>
                    <span className="font-semibold tabular-nums">({fmtRM(previewDownlineCost)})</span>
                  </div>
                  <div className="flex justify-between mt-1 pt-1 border-t border-[#DDE5E5]">
                    <span className="font-semibold text-[#0A1F2E]">Net Commission</span>
                    <span className={`font-bold tabular-nums ${previewNet >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>{fmtRM(previewNet)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#DDE5E5] flex items-center justify-between gap-2 shrink-0 bg-white">
          <div>
            {!confirmDelete ? (
              <button type="button" onClick={() => setConfirmDelete(true)}
                className="h-7 px-2 rounded border border-red-200 text-[10px] font-semibold text-red-600 hover:bg-red-50 inline-flex items-center gap-1">
                <Trash2 className="h-3 w-3" /> Remove
              </button>
            ) : (
              <div className="flex gap-1.5 items-center">
                <span className="text-[10px] text-red-600">Sure?</span>
                <button type="button" onClick={() => { removeMember(member.id); onClose(); }} className="h-7 px-2 rounded bg-red-600 text-white text-[10px] font-semibold">Yes</button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="h-7 px-2 rounded border border-[#DDE5E5] text-[10px] font-semibold text-gray-600">No</button>
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

// ─── Commission Settings Dialog ─────────────────────────────────────────────

function CommissionSettingsDialog({ onClose }: { onClose: () => void }) {
  const [tiers, setTiers] = useState<CommissionTier[]>(readDefaultCommission());

  function addTier() {
    const last = tiers.length > 0 ? tiers[tiers.length - 1] : null;
    setTiers([...tiers, {
      threshold: (last?.threshold ?? 0) + 100000,
      pct: (last?.pct ?? 0) + 1,
    }]);
  }

  function updateTier(i: number, patch: Partial<CommissionTier>) {
    setTiers((prev) => prev.map((t, idx) => idx === i ? { ...t, ...patch } : t));
  }

  function removeTier(i: number) {
    setTiers((prev) => prev.filter((_, idx) => idx !== i));
  }

  function save() {
    writeDefaultCommission(tiers);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg border border-[#DDE5E5] shadow-xl w-full max-w-md mx-4 overflow-hidden max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between shrink-0">
          <h3 className="text-[13px] font-semibold text-[#0A1F2E]">
            <DollarSign className="h-4 w-4 inline mr-1.5 -mt-0.5 text-[#0F766E]" />
            Commission Settings
          </h3>
          <button type="button" onClick={onClose} className="h-6 w-6 rounded hover:bg-gray-200 inline-flex items-center justify-center text-gray-400 hover:text-gray-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-md border border-[#DDE5E5] overflow-hidden">
            <table className="w-full text-[11px]">
              <thead className="bg-[#F4F7F7] text-[9px] font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="text-left px-3 py-1.5">Sales Threshold (RM)</th>
                  <th className="text-left px-3 py-1.5">Rate %</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0F3F3]">
                {tiers.map((t, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1.5">
                      <input type="number" value={t.threshold} onChange={(e) => updateTier(i, { threshold: Number(e.target.value) })}
                        className="w-full h-6 rounded border border-[#DDE5E5] px-1.5 text-[11px] tabular-nums" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input type="number" step="0.5" value={t.pct} onChange={(e) => updateTier(i, { pct: Number(e.target.value) })}
                        className="w-full h-6 rounded border border-[#DDE5E5] px-1.5 text-[11px] tabular-nums" />
                    </td>
                    <td className="px-1">
                      <button type="button" onClick={() => removeTier(i)} className="h-5 w-5 rounded hover:bg-red-50 inline-flex items-center justify-center text-gray-300 hover:text-red-500">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}
                {tiers.length === 0 && (
                  <tr><td colSpan={3} className="px-3 py-3 text-center text-[10px] text-gray-400">No tiers — add one below</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <button type="button" onClick={addTier}
            className="h-7 px-2.5 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-[#0F766E] hover:border-[#0F766E] inline-flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add tier
          </button>

          <div className="text-[10px] text-gray-500">
            Group sales tiers — applies to all members without custom tiers.
          </div>
        </div>
        <div className="px-5 py-3 border-t border-[#DDE5E5] flex justify-end gap-2 shrink-0 bg-white">
          <button type="button" onClick={onClose} className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600">Cancel</button>
          <button type="button" onClick={save} className="h-8 px-4 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1">
            <Check className="h-3 w-3" /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tree Row (List View) ───────────────────────────────────────────────────

function TreeRow({ node, collapsed, onToggle, onEdit, isLast, parentGuides, onQuickRole }: {
  node: MemberNode; collapsed: boolean; onToggle: () => void; onEdit: () => void;
  isLast: boolean; parentGuides: boolean[]; onQuickRole?: (m: SalesMember) => void;
}) {
  const m = node.member;
  const hasChildren = node.children.length > 0;
  const depth = node.depth;
  return (
    <div
      className="relative flex items-center gap-2 py-2 hover:bg-[#FAFBFB] cursor-pointer border-b border-[#F0F3F3] last:border-b-0"
      style={{ paddingLeft: `${depth * 24 + 16}px`, paddingRight: '16px' }}
      onClick={onEdit}
    >
      {depth > 0 && (
        <>
          {parentGuides.map((show, i) =>
            show ? (
              <div key={`g${i}`} className="absolute top-0 bottom-0 w-px bg-[#DDE5E5]" style={{ left: `${i * 24 + 16 + 11}px` }} />
            ) : null
          )}
          <div
            className={`absolute w-px bg-[#DDE5E5] ${isLast ? '' : 'bottom-0'}`}
            style={{
              left: `${(depth - 1) * 24 + 16 + 11}px`,
              top: 0,
              height: isLast ? '50%' : undefined,
            }}
          />
          <div
            className="absolute h-px bg-[#DDE5E5]"
            style={{
              left: `${(depth - 1) * 24 + 16 + 11}px`,
              top: '50%',
              width: '13px',
            }}
          />
        </>
      )}

      <div className="w-4 shrink-0">
        {hasChildren ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className="h-4 w-4 rounded hover:bg-gray-200 inline-flex items-center justify-center text-gray-400">
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        ) : null}
      </div>

      <div className={`h-7 w-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold ${
        m.status === "INACTIVE" ? "bg-gray-200 text-gray-400" :
        m.position.includes("Director") ? "bg-amber-100 text-amber-700" :
        "bg-[#0F766E]/10 text-[#0F766E]"
      }`}>
        {m.name.charAt(0)}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-[12px] font-semibold truncate ${m.status === "INACTIVE" ? "text-gray-400 line-through" : "text-[#0A1F2E]"}`}>
            {m.name}
          </span>
          {m.code !== m.name && <span className="text-[9px] text-gray-400">({m.code})</span>}
          <StatusDot status={m.status} />
        </div>
        <div className="flex items-center gap-2 text-[9px] text-gray-500">
          {m.phone && <span className="inline-flex items-center gap-0.5 tabular-nums"><Phone className="h-2 w-2" />{m.phone}</span>}
          {m.email && <span className="inline-flex items-center gap-0.5 truncate max-w-[180px]"><Mail className="h-2 w-2" />{m.email}</span>}
        </div>
      </div>

      {/* Hide brand dots on mobile (too cluttered) */}
      <div className="hidden md:flex items-center">
        <BrandDots brands={m.position === "Sales Director" ? BRANDS : m.assignedBrands} />
      </div>
      <RoleBadge position={m.position} />
      {/* Hide full PositionBadge on mobile — RoleBadge already conveys role */}
      <div className="hidden md:block">
        <PositionBadge position={m.position} />
      </div>

      {node.descendantCount > 0 && (
        <span className="text-[9px] font-semibold text-[#0F766E] bg-[#0F766E]/10 rounded px-1.5 py-0.5 tabular-nums shrink-0">
          {node.descendantCount}
        </span>
      )}

      {/* Quick role toggle — shorter label on mobile */}
      {onQuickRole && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onQuickRole(m); }}
          className={`h-6 px-2 rounded border text-[9px] font-semibold shrink-0 transition ${
            m.position.includes("Director")
              ? "border-red-200 text-red-600 hover:bg-red-50"
              : "border-[#0F766E]/40 text-[#0F766E] hover:bg-[#0F766E]/10"
          }`}
          title={m.position.includes("Director") ? "Remove Admin" : "Make Admin"}
        >
          <span className="hidden md:inline">{m.position.includes("Director") ? "Remove Admin" : "Make Admin"}</span>
          <span className="md:hidden">{m.position.includes("Director") ? "−" : "+"}</span>
        </button>
      )}
    </div>
  );
}

function renderTreeRows(
  nodes: MemberNode[],
  collapsedIds: Set<string>,
  onToggle: (id: string) => void,
  onEdit: (m: SalesMember) => void,
  parentGuides: boolean[] = [],
  onQuickRole?: (m: SalesMember) => void,
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    result.push(
      <TreeRow
        key={node.member.id}
        node={node}
        collapsed={collapsedIds.has(node.member.id)}
        onToggle={() => onToggle(node.member.id)}
        onEdit={() => onEdit(node.member)}
        isLast={isLast}
        parentGuides={parentGuides}
        onQuickRole={onQuickRole}
      />
    );
    if (!collapsedIds.has(node.member.id) && node.children.length > 0) {
      const childGuides = [...parentGuides, !isLast];
      result.push(...renderTreeRows(node.children, collapsedIds, onToggle, onEdit, childGuides, onQuickRole));
    }
  });
  return result;
}

// ─── Org Chart Node (Visual Tree View) ──────────────────────────────────────

function OrgChartNode({ node, onEdit }: {
  node: MemberNode; onEdit: (m: SalesMember) => void;
}) {
  const m = node.member;
  const isDir = m.position.includes("Director");
  const children = node.children;

  return (
    <div className="flex flex-col items-center">
      <div
        onClick={() => onEdit(m)}
        className={`w-[130px] rounded-lg border p-2 cursor-pointer transition-all hover:shadow-md hover:-translate-y-0.5 ${
          isDir
            ? "bg-amber-50 border-amber-200 hover:border-amber-400"
            : "bg-white border-[#DDE5E5] hover:border-[#0F766E]"
        }`}
      >
        <div className="flex justify-center mb-1">
          <div className={`h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-bold ${
            m.status === "INACTIVE" ? "bg-gray-200 text-gray-400" :
            isDir ? "bg-amber-100 text-amber-700" :
            "bg-[#0F766E]/10 text-[#0F766E]"
          }`}>
            {m.name.charAt(0)}
          </div>
        </div>
        <div className={`text-[11px] font-semibold text-center truncate ${
          m.status === "INACTIVE" ? "text-gray-400 line-through" : "text-[#0A1F2E]"
        }`}>
          {m.name}
        </div>
        <div className="flex justify-center mt-1">
          <span className={`inline-flex items-center gap-0.5 px-1 py-px rounded text-[8px] font-semibold ${
            isDir ? "bg-amber-100 text-amber-700" :
            m.position.includes("Manager") ? "bg-blue-100 text-blue-700" :
            "bg-gray-100 text-gray-500"
          }`}>
            {isDir ? <Crown className="h-2 w-2" /> : m.position.includes("Manager") ? <Shield className="h-2 w-2" /> : <UserIcon className="h-2 w-2" />}
            {m.position.replace("Sales ", "")}
          </span>
        </div>
        <div className="flex items-center justify-center gap-1.5 mt-1">
          <BrandDotsCompact brands={m.position === "Sales Director" ? BRANDS : m.assignedBrands} />
          {node.descendantCount > 0 && (
            <span className="text-[8px] font-semibold text-[#0F766E] bg-[#0F766E]/10 rounded px-1 py-px tabular-nums">
              {node.descendantCount}
            </span>
          )}
        </div>
      </div>

      {children.length > 0 && (
        <>
          <div className="w-px h-6 bg-[#DDE5E5]" />

          {children.length === 1 ? (
            <div className="flex flex-col items-center">
              <OrgChartNode node={children[0]} onEdit={onEdit} />
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <div className="relative flex gap-4">
                <div
                  className="absolute h-px bg-[#DDE5E5]"
                  style={{
                    top: 0,
                    left: `calc(${100 / (2 * children.length)}%)`,
                    right: `calc(${100 / (2 * children.length)}%)`,
                  }}
                />
                {children.map((child) => (
                  <div key={child.member.id} className="flex flex-col items-center">
                    <div className="w-px h-6 bg-[#DDE5E5]" />
                    <OrgChartNode node={child} onEdit={onEdit} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
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
  const [filterPosition, setFilterPosition] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState<MemberStatus | "ALL">("ALL");
  const [filterBrand, setFilterBrand] = useState<Brand | "ALL">("ALL");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [confirmReset, setConfirmReset] = useState(false);
  const [chartView, setChartView] = useState<"list" | "orgchart">("list");
  const [showCommissionSettings, setShowCommissionSettings] = useState(false);

  const positions = readPositions();

  const tree = useMemo(() => buildTree(members), [members]);
  const flat = useMemo(() => flattenTree(tree), [tree]);

  const isFiltering = search.trim() !== "" || filterPosition !== "ALL" || filterStatus !== "ALL" || filterBrand !== "ALL";
  const q = search.trim().toUpperCase();

  const filteredFlat = useMemo(() => {
    if (!isFiltering) return flat;
    return flat.filter((n) => {
      const m = n.member;
      if (filterPosition !== "ALL" && m.position !== filterPosition) return false;
      if (filterStatus !== "ALL" && m.status !== filterStatus) return false;
      if (filterBrand !== "ALL" && !m.assignedBrands.includes(filterBrand)) return false;
      if (q) {
        const hay = [m.name, m.code, m.phone, m.email, m.ic ?? "", m.position].join(" ").toUpperCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [flat, isFiltering, filterPosition, filterStatus, filterBrand, q]);

  const visibleNodes = useMemo(() => {
    if (isFiltering) return filteredFlat;
    const result: MemberNode[] = [];
    function walk(nodes: MemberNode[]) {
      for (const n of nodes) { result.push(n); if (!collapsedIds.has(n.member.id)) walk(n.children); }
    }
    walk(tree);
    return result;
  }, [tree, filteredFlat, isFiltering, collapsedIds]);

  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  const uniquePositions = useMemo(() => Array.from(new Set(members.map((m) => m.position))).sort(), [members]);
  const activeCount = members.filter((m) => m.status === "ACTIVE").length;
  const dirCount = members.filter((m) => m.position.includes("Director") && m.status === "ACTIVE").length;
  const brandedCount = members.filter((m) => m.assignedBrands.length > 0 && m.status === "ACTIVE").length;

  function handleQuickRole(m: SalesMember) {
    if (m.position.includes("Director")) {
      updateMember(m.id, { position: "Sales Executive" });
    } else {
      updateMember(m.id, { position: "Sales Director" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E]">Sales Team</h1>
          <p className="text-sm text-gray-500 mt-1 inline-flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" />
            Organisation chart, position, brand assignment &amp; commission
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowCommissionSettings(true)}
            className="h-9 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1.5">
            <Settings className="h-3.5 w-3.5" /> Settings
          </button>
          <button type="button" onClick={() => setConfirmReset(true)}
            className="h-9 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-red-300 hover:text-red-600 inline-flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> Reset
          </button>
          <button type="button" onClick={() => setShowAdd(true)}
            className="h-9 px-3.5 rounded-md bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5">
            <UserPlus className="h-4 w-4" /> Register Member
          </button>
        </div>
      </div>

      {confirmReset && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 flex items-center justify-between gap-3">
          <div className="text-[11px] text-red-700">Reset all sales data to seed (from Excel export)?</div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirmReset(false)} className="h-7 px-2.5 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-gray-600">Cancel</button>
            <button type="button" onClick={() => { resetSalesMembers(); setConfirmReset(false); }} className="h-7 px-2.5 rounded bg-red-600 text-white text-[10px] font-semibold hover:bg-red-700">Yes, reset</button>
          </div>
        </div>
      )}

      {/* Roles & Permissions card */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center gap-2">
          <Shield className="h-3.5 w-3.5 text-[#0F766E]" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Roles &amp; Permissions</h2>
        </div>
        <div className="p-4 space-y-3">
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Administrators */}
            <div className="flex items-center gap-3 rounded-md border border-[#DDE5E5] px-4 py-3 bg-[#0F766E]/5">
              <div className="h-9 w-9 rounded-full bg-[#0F766E]/20 flex items-center justify-center shrink-0">
                <Crown className="h-4 w-4 text-[#0F766E]" />
              </div>
              <div>
                <div className="text-[9px] font-semibold uppercase tracking-wider text-[#0F766E]">Administrators</div>
                <div className="text-2xl font-bold text-[#0F766E] tabular-nums">
                  {members.filter((m) => m.position.includes("Director")).length}
                </div>
                <div className="text-[9px] text-gray-400">Sales Director</div>
              </div>
            </div>
            {/* Managers */}
            <div className="flex items-center gap-3 rounded-md border border-[#DDE5E5] px-4 py-3 bg-blue-50">
              <div className="h-9 w-9 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                <Shield className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <div className="text-[9px] font-semibold uppercase tracking-wider text-blue-600">Managers</div>
                <div className="text-2xl font-bold text-blue-700 tabular-nums">
                  {members.filter((m) => m.position.includes("Manager")).length}
                </div>
                <div className="text-[9px] text-gray-400">Sales Manager</div>
              </div>
            </div>
            {/* Executives */}
            <div className="flex items-center gap-3 rounded-md border border-[#DDE5E5] px-4 py-3 bg-gray-50">
              <div className="h-9 w-9 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                <UserIcon className="h-4 w-4 text-gray-500" />
              </div>
              <div>
                <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-500">Executives</div>
                <div className="text-2xl font-bold text-gray-700 tabular-nums">
                  {members.filter((m) => !m.position.includes("Director") && !m.position.includes("Manager")).length}
                </div>
                <div className="text-[9px] text-gray-400">Other positions</div>
              </div>
            </div>
          </div>
          {/* Permission rules */}
          <div className="rounded-md bg-[#F4F7F7] border border-[#DDE5E5] px-4 py-2.5 text-[10px] text-gray-500 space-y-1">
            <div className="font-semibold text-[#0A1F2E] mb-1">Permission rules:</div>
            <div className="flex items-start gap-1.5"><span className="text-[#0F766E] shrink-0">•</span><span><span className="font-semibold text-[#0A1F2E]">Administrator</span> — full access to all events, financial reports, and settings</span></div>
            <div className="flex items-start gap-1.5"><span className="text-blue-500 shrink-0">•</span><span><span className="font-semibold text-[#0A1F2E]">Manager / Executive</span> — limited to events assigned to them, plus live events (floorplan + chat only)</span></div>
            <div className="flex items-start gap-1.5"><span className="text-gray-400 shrink-0">•</span><span>Change someone's role by clicking <span className="font-semibold">Edit</span> on their row and selecting a different Position</span></div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Active", value: activeCount, color: "text-[#0F766E]" },
          { label: "Directors", value: dirCount, color: "text-amber-700" },
          { label: "Brand Assigned", value: brandedCount, color: "text-blue-700" },
          { label: "Total Members", value: members.length, color: "text-gray-700" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-[#DDE5E5] bg-white px-4 py-3">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">{s.label}</div>
            <div className={`text-xl font-bold ${s.color} mt-0.5 tabular-nums`}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white p-2.5 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, phone, email..."
            className="w-full h-8 pl-8 pr-8 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-[#0A1F2E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]" />
          {search && <button type="button" onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100"><X className="h-3 w-3" /></button>}
        </div>

        <select value={filterPosition} onChange={(e) => setFilterPosition(e.target.value)} className={FILTER_SELECT}>
          <option value="ALL">All positions</option>
          {uniquePositions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select value={filterBrand} onChange={(e) => setFilterBrand(e.target.value as Brand | "ALL")} className={FILTER_SELECT}>
          <option value="ALL">All brands</option>
          {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as MemberStatus | "ALL")} className={FILTER_SELECT}>
          <option value="ALL">All status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        {isFiltering && (
          <button type="button" onClick={() => { setSearch(""); setFilterPosition("ALL"); setFilterBrand("ALL"); setFilterStatus("ALL"); }}
            className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-red-300 hover:text-red-600 inline-flex items-center gap-1">
            <X className="h-3 w-3" /> Clear
          </button>
        )}
        <div className="ml-auto text-[10px] text-gray-500 tabular-nums">{visibleNodes.length} / {members.length}</div>
      </div>

      {/* Org Chart */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#0A1F2E]">
              {isFiltering ? "Search Results" : "Organisation Chart"}
            </h2>
            <p className="text-[10px] text-gray-500 mt-0.5">
              {isFiltering ? "Flat list — clear filters to see hierarchy" : "Click to edit \u00B7 Director \u2192 Executive \u2192 Sub-Executive"}
            </p>
          </div>
          {!isFiltering && (
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setChartView("list")}
                className={`h-7 px-2 rounded border text-[10px] font-semibold inline-flex items-center gap-1 ${
                  chartView === "list"
                    ? "bg-[#0F766E] text-white border-[#0F766E]"
                    : "bg-white text-gray-600 border-[#DDE5E5] hover:border-[#0F766E] hover:text-[#0F766E]"
                }`}>
                <List className="h-3 w-3" /> List
              </button>
              <button type="button" onClick={() => setChartView("orgchart")}
                className={`h-7 px-2 rounded border text-[10px] font-semibold inline-flex items-center gap-1 ${
                  chartView === "orgchart"
                    ? "bg-[#0F766E] text-white border-[#0F766E]"
                    : "bg-white text-gray-600 border-[#DDE5E5] hover:border-[#0F766E] hover:text-[#0F766E]"
                }`}>
                <GitBranch className="h-3 w-3" /> Org Chart
              </button>
              <span className="w-px h-5 bg-[#DDE5E5] self-center mx-0.5" />
              <button type="button" onClick={() => setCollapsedIds(new Set())}
                className="h-7 px-2 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E]">Expand</button>
              <button type="button" onClick={() => setCollapsedIds(new Set(members.map((m) => m.id)))}
                className="h-7 px-2 rounded border border-[#DDE5E5] bg-white text-[10px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E]">Collapse</button>
            </div>
          )}
        </div>

        {visibleNodes.length === 0 ? (
          <div className="p-8 text-center text-[11px] text-gray-400">
            {isFiltering ? "No members match" : "No members — register your first one"}
          </div>
        ) : chartView === "orgchart" && !isFiltering ? (
          <div className="overflow-x-auto p-6">
            <div className="flex gap-8 justify-center min-w-max">
              {tree.map((rootNode) => (
                <OrgChartNode
                  key={rootNode.member.id}
                  node={rootNode}
                  onEdit={(m) => setEditMember(m)}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            {isFiltering
              ? visibleNodes.map((node) => (
                  <TreeRow key={node.member.id} node={{...node, depth: 0}} collapsed={false} onToggle={() => {}} onEdit={() => setEditMember(node.member)} isLast={true} parentGuides={[]} onQuickRole={handleQuickRole} />
                ))
              : renderTreeRows(tree, collapsedIds, (id) => toggleCollapse(id), (m) => setEditMember(m), [], handleQuickRole)
            }
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-[10px] text-gray-500">
        <span className="font-semibold uppercase tracking-wider">Brands:</span>
        {BRANDS.map((b) => (
          <span key={b} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${BRAND_DOT[b]}`} /> {b}
          </span>
        ))}
        <span className="w-px h-3 bg-[#DDE5E5]" />
        <span className="inline-flex items-center gap-1"><Crown className="h-3 w-3 text-amber-600" /> Director</span>
        <span className="inline-flex items-center gap-1"><UserIcon className="h-3 w-3 text-gray-500" /> Executive</span>
      </div>

      {showAdd && <AddMemberForm members={members} positions={positions} onClose={() => setShowAdd(false)} />}
      {editMember && <EditMemberDialog member={editMember} members={members} positions={positions} onClose={() => setEditMember(null)} />}
      {showCommissionSettings && <CommissionSettingsDialog onClose={() => setShowCommissionSettings(false)} />}
    </div>
  );
}
