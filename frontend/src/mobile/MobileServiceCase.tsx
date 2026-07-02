import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useChoice } from "../vendor/scm/components/ChoiceDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import "./mobile.css";

// The core /api/assr route (NOT scm). The list returns
// { data, page, per_page, total } with assr_cases.* columns; the detail
// returns { case, items, attachments, activity, logistics, related_pos,
// stage_history, portal_token }.
//
// The Postgres driver camelCases every result column, so the same field
// can arrive as camelCase or snake_case depending on the path — we always
// dual-read `r.camelCase ?? r.snake_case` and never crash on a missing one.
//
// This screen is a FAITHFUL port of the owner's "Houzs Mobile.html" design
// (sections #m-service list / #service detail / #service-new form). It uses
// the design's own CSS classes (.hz-m: .hdr .ey .sochip .so-row .so-grid
// .spill .pacc .psec-t .pbody .pstage .pdot .rbadge .tinybtn .pgrid2
// .so-card .so-hd .so-ti .so-bd .fld .fld-l .fld-i .actbar .btn) — not inline
// styles. Only the genuinely dynamic values (pill colours, stage state,
// SLA overdue red) remain inline, exactly as the design markup does.

type Any = Record<string, any>;

// ── design colour tokens (only for the genuinely dynamic bits the design
//    also keeps inline: pill bg/fg pairs, stage dot state, SLA red) ──
const INK = "#11140f";
const MUTED = "#767b6e";
const TEAL = "#16695f";
const TEAL_DK = "#0c3f39";
const BROWN = "#a16a2e";
const GREEN = "#2f8a5b";
const RED = "#b23a3a";
const GREY = "#9aa093";
const LINE = "#d6d9d2";
const FIELD_BG = "#f4f6f3";

// Ordered stage pipeline (backend ALL_STAGES). Short mobile labels as per
// the design's 9-stage pipeline (Review…Completed).
const STAGES: { key: string; label: string }[] = [
  { key: "pending_review", label: "Review" },
  { key: "under_verification", label: "Verify" },
  { key: "pending_solution", label: "Solution" },
  { key: "pending_inspection", label: "Inspection" },
  { key: "pending_item_pickup", label: "Item Pickup" },
  { key: "pending_supplier_pickup", label: "Supplier" },
  { key: "pending_item_ready", label: "Item Ready" },
  { key: "pending_delivery_service", label: "Delivery" },
  { key: "completed", label: "Completed" },
];
const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

// ── Enum option lists (mirrors desktop ServiceCases.tsx) ──────────
// PATCH /:id accepts these column values; the mobile edit sheets write
// the same field names + values the desktop InlineEdit controls do.
const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"] as const;
const ISSUE_CATEGORY_OPTIONS = [
  "Product defect",
  "Incorrect item delivered",
  "Missing / short item",
  "Warranty / service request",
  "Installation / assembly issue",
] as const;
const RESOLUTION_OPTIONS = [
  "replace_unit",
  "supplier_repair",
  "field_service_own",
  "field_service_supplier",
  "return_visit",
] as const;
// Under-Verification outcome (mig 081 verification_outcome column).
const VERIFICATION_OPTIONS = [
  { value: "accepted", label: "Accepted" },
  { value: "needs_more_info", label: "Needs more info" },
  { value: "rejected", label: "Rejected" },
] as const;
// QC / inspection result (v3.1 inspection_result column).
const INSPECTION_OPTIONS = ["pass", "fail", "na"] as const;
// Timeline note audience — the /:id/notes endpoint only accepts these two
// ("system" is reserved for auto events and rejected server-side).
const NOTE_AUDIENCE_OPTIONS = [
  { value: "purchasing", label: "Internal (Purchasing)", detail: "Hidden from the customer" },
  { value: "customer", label: "Customer-visible", detail: "Shows on the customer portal" },
] as const;
// Print copy variants — desktop opens /api/assr-print/:id?variant=…
const PRINT_VARIANTS = [
  { value: "customer", label: "Customer copy" },
  { value: "supplier", label: "Supplier copy" },
  { value: "office", label: "Office copy" },
] as const;
// Upload constraints mirror the PUT /:id/attachments backend guard.
const ATTACH_EXTS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "pdf"]);

// Pill colours — design PILL map (bg, fg). Open stages read as amber, the
// "waiting on our side" ones teal, completed green, cancelled red.
const STAGE_PILL: Record<string, [string, string]> = {
  pending_review: ["#f6efd9", "#6e4d12"],
  under_verification: ["#f6efd9", "#6e4d12"],
  pending_solution: ["#f6efd9", "#6e4d12"],
  pending_inspection: ["#e1efed", TEAL_DK],
  pending_item_pickup: ["#f6efd9", "#6e4d12"],
  pending_supplier_pickup: ["#f6efd9", "#6e4d12"],
  pending_item_ready: ["#e1efed", TEAL_DK],
  pending_delivery_service: ["#f6efd9", "#6e4d12"],
  completed: ["#e2f0e9", GREEN],
};
const PRIORITY_PILL: Record<string, [string, string]> = {
  urgent: ["#f8eaea", RED],
  high: ["#f6efd9", "#6e4d12"],
  normal: [FIELD_BG, "#6e4d12"],
  low: [FIELD_BG, MUTED],
};

// Canonical badge class per spec STATES(stage): the "waiting on our side"
// stages read petrol (b-brand), completed green, everything else amber.
function stageBadgeClass(stage: string): string {
  if (stage === "completed") return "b-green";
  if (stage === "pending_inspection" || stage === "pending_item_ready") return "b-brand";
  return "b-amber";
}
// Spec priority chip: LOW=grey · MEDIUM/normal=amber · HIGH/urgent=red.
function priorityBadgeClass(priority: string): string {
  const p = priority.toLowerCase();
  if (p === "high" || p === "urgent") return "b-red";
  if (p === "low") return "b-grey";
  return "b-amber";
}

// ── field readers (dual-read camelCase / snake_case) ──────────────
const get = (r: Any, ...keys: string[]) => {
  for (const k of keys) {
    const v = r?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const caseNo = (r: Any) => get(r, "assrNo", "assr_no", "docNo", "doc_no") ?? "—";
const customer = (r: Any) => get(r, "customerName", "customer_name") ?? "—";
const stageOf = (r: Any) => String(get(r, "stage") ?? "");
const priorityOf = (r: Any) => String(get(r, "priority") ?? "normal").toLowerCase();
const statusOf = (r: Any) => String(get(r, "status") ?? "");
const issueOf = (r: Any) => get(r, "complaintIssue", "complaint_issue");
const hoursToDeadline = (r: Any): number | null => {
  const v = get(r, "hoursToDeadline", "hours_to_deadline");
  return v == null ? null : Number(v);
};

// ── Lookup option hooks (mirror desktop) ──────────────────────────
// The four assr pickers live behind /api/assr/lookups/:kind, which
// returns { data: [{ id, slug, name, sort_order, active }] }. Desktop
// reads issue-categories by `name` and resolution-methods / priorities
// by `slug`. We do the same, falling back to the hardcoded constant
// until the (cheap, cached) call returns so the form stays usable.
type LookupOpt = { slug: string; name: string };
function useLookupRows(kind: string): LookupOpt[] {
  const { data } = useQuery({
    queryKey: ["mobile-assr-lookup", kind],
    queryFn: () => api.get<{ data?: LookupOpt[] }>(`/api/assr/lookups/${kind}`),
    staleTime: 5 * 60_000,
  });
  return data?.data ?? [];
}
function useLookupNames(kind: string, fallback: readonly string[]): string[] {
  const rows = useLookupRows(kind);
  return rows.length ? rows.map((r) => r.name) : [...fallback];
}
function useLookupSlugs(kind: string, fallback: readonly string[]): string[] {
  const rows = useLookupRows(kind);
  return rows.length ? rows.map((r) => r.slug) : [...fallback];
}

// Assignable users for the PIC picker — mirrors desktop DetailContent, which
// pulls /api/users (shape { users } | { data } | array) and narrows the picker
// to Operations-department members (plus whoever is currently assigned so an
// out-of-Operations assignment never silently vanishes from the list).
type PicUser = { id: number; name: string; department_name?: string };
function useAssignableUsers(): PicUser[] {
  const { data } = useQuery({
    queryKey: ["mobile-assr-users"],
    queryFn: () =>
      api
        .get<any>("/api/users")
        .then((r: any) => (r?.users ?? r?.data ?? r ?? []) as PicUser[]),
    staleTime: 5 * 60_000,
  });
  return Array.isArray(data) ? data : [];
}

// SO typeahead — mirrors desktop CreatePanel: GET /api/assr/search-so?q=…
// returns { results: [{ doc_no, ref, debtor_name, phone, doc_date,
// sales_agent }] } (min 2 chars server-side). Debounced client-side.
type SoHit = Any;
function useSoSearch(q: string): { results: SoHit[]; loading: boolean } {
  const needle = q.trim();
  const { data, isFetching } = useQuery({
    queryKey: ["mobile-assr-so-search", needle],
    enabled: needle.length >= 2,
    staleTime: 30_000,
    queryFn: () =>
      api.get<{ results?: SoHit[] }>(`/api/assr/search-so?q=${encodeURIComponent(needle)}`),
  });
  return { results: data?.results ?? [], loading: isFetching };
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Human labels for the resolution_method slugs (mirrors desktop).
const RESOLUTION_LABELS: Record<string, string> = {
  replace_unit: "Replace unit",
  supplier_repair: "Supplier repair",
  field_service_own: "Field service (own)",
  field_service_supplier: "Field service (supplier)",
  return_visit: "Return visit",
};
const resolutionLabel = (v: string) => RESOLUTION_LABELS[v] ?? cap(v.replace(/_/g, " "));
const prettyStage = (stage: string) => {
  const idx = STAGE_INDEX[stage];
  const label = idx != null ? STAGES[idx].label : stage.replace(/_/g, " ");
  return label ? cap(label) : "—";
};
const dm = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(+dt)) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
const dtm = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(+dt)) return "—";
  return dt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
// Human overdue / due-in from hours-to-deadline (drives the SLA chip).
const slaText = (h: number | null): { label: string; overdue: boolean } | null => {
  if (h == null || !isFinite(h)) return null;
  if (h < 0) {
    const days = Math.floor(-h / 24);
    return { label: days >= 1 ? `${days} days overdue` : `Overdue ${Math.abs(Math.round(h))}h`, overdue: true };
  }
  const days = Math.floor(h / 24);
  return { label: days >= 1 ? `Due in ${days} days` : `Due in ${Math.round(h)}h`, overdue: false };
};

/** Mobile Service Case (ASSR) — faithful port of the owner's design.
 *  Searchable list + rich read-first detail + new-case form, all wired to
 *  the core /api/assr backend. */
export function MobileServiceCase({ onBack }: { onBack?: () => void }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);

  if (openId != null) {
    return <CaseDetail id={openId} onBack={() => setOpenId(null)} />;
  }
  return (
    <>
      <CaseList onBack={onBack} onOpen={setOpenId} onNew={() => setShowNew(true)} />
      {showNew && <NewCaseSheet onClose={() => setShowNew(false)} onOpen={setOpenId} />}
    </>
  );
}

// ── LIST (#m-service) ─────────────────────────────────────────────
function CaseList({
  onBack,
  onOpen,
  onNew,
}: {
  onBack?: () => void;
  onOpen: (id: number) => void;
  onNew: () => void;
}) {
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("all");
  const [sort, setSort] = useState<"sla" | "no">("sla");

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-assr-list"],
    queryFn: () => api.get<{ data?: Any[] }>("/api/assr?per_page=200"),
    staleTime: 30_000,
  });
  const all = data?.data ?? [];

  // Spec chips (service-list): All / Pending pickup / Item ready / Delivery / Completed.
  const CHIPS: { key: string; label: string; match: (r: Any) => boolean }[] = [
    { key: "all", label: "All", match: () => true },
    { key: "pending", label: "Pending pickup", match: (r) => ["pending_item_pickup", "pending_supplier_pickup", "pending_review", "under_verification", "pending_solution", "pending_inspection"].includes(stageOf(r)) },
    { key: "item_ready", label: "Item ready", match: (r) => stageOf(r) === "pending_item_ready" },
    { key: "delivery", label: "Delivery", match: (r) => stageOf(r) === "pending_delivery_service" },
    { key: "completed", label: "Completed", match: (r) => stageOf(r) === "completed" },
  ];

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const ch of CHIPS) c[ch.key] = all.filter(ch.match).length;
    return c;
  }, [all]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const active = CHIPS.find((c) => c.key === chip) ?? CHIPS[0];
    let out = all.filter((r) => {
      if (!active.match(r)) return false;
      if (needle) {
        const hay = `${customer(r)} ${caseNo(r)} ${issueOf(r) ?? ""} ${get(r, "itemDescription", "item_description", "itemCode", "item_code") ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    out = out.slice().sort((a, b) => {
      if (sort === "no") return String(caseNo(a)).localeCompare(String(caseNo(b)), undefined, { numeric: true });
      // SLA: most-overdue (smallest hours) first; nulls last.
      const ha = hoursToDeadline(a);
      const hb = hoursToDeadline(b);
      if (ha == null && hb == null) return 0;
      if (ha == null) return 1;
      if (hb == null) return -1;
      return ha - hb;
    });
    return out;
  }, [all, q, chip, sort]);

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* header (.hdr) — eyebrow + title + new-case iconbtn (spec #service-list) */}
      <header className="hdr">
        <div className="hdr-row">
          <div>
            {onBack ? (
              <button className="back" onClick={onBack} style={{ marginBottom: 4 }}>
                <span className="chev">‹</span> Menu
              </button>
            ) : null}
            <div className="eyebrow">Quality</div>
            <div className="scr-title">Service Cases</div>
          </div>
          <button onClick={onNew} className="iconbtn" aria-label="New service case">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={TEAL} strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={GREY} strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search case · customer · item" />
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as "sla" | "no")} style={{ flex: "none", fontFamily: "inherit", fontSize: 12, color: "var(--mut)", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "0 8px", height: 38, appearance: "none", WebkitAppearance: "none" }}>
            <option value="sla">Sort: SLA</option>
            <option value="no">Sort: Case</option>
          </select>
        </div>
        <div className="chips" style={{ marginTop: 11 }}>
          {CHIPS.map((c) => (
            <button key={c.key} className={`chip${chip === c.key ? " on" : ""}`} onClick={() => setChip(c.key)}>
              {c.label} ({counts[c.key] ?? 0})
            </button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {isLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load service cases. Pull to retry.</div>}
        {!isLoading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map((r) => {
              const id = Number(get(r, "id"));
              const cancelled = statusOf(r).toLowerCase() === "cancelled";
              const sla = slaText(hoursToDeadline(r));
              const item = get(r, "itemDescription", "item_description", "itemCode", "item_code");
              // Spec card: name + stage badge · case_no · product · issue · priority + SLA.
              return (
                <div key={id} className="card" onClick={() => onOpen(id)} style={{ cursor: "pointer", ...(cancelled ? { opacity: 0.55, filter: "grayscale(.5)" } : null) }}>
                  <div className="card-b" style={{ padding: "12px 13px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)", ...cellEllipsis }}>{customer(r)}</span>
                      <span className={`badge ${stageBadgeClass(stageOf(r))}`} style={{ flex: "none" }}>{prettyStage(stageOf(r))}</span>
                    </div>
                    <div className="tnum" style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 5, ...cellEllipsis }}>{String(caseNo(r))}{item ? ` · ${String(item)}` : ""}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 6, ...cellEllipsis }}>{issueOf(r) ? String(issueOf(r)) : "—"}</div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
                      <span className={`badge ${priorityBadgeClass(priorityOf(r))}`}>{cap(priorityOf(r))}</span>
                      {sla && <span style={{ fontSize: 11, fontWeight: 700, color: sla.overdue ? "var(--red)" : "var(--mut)" }}>{sla.label}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {!rows.length && (
              <div className="empty">
                <div className="empty-t">Nothing matches</div>
                <div className="empty-s">Try a different filter or search.</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── DETAIL (#service) ─────────────────────────────────────────────
function CaseDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const choose = useChoice();
  const prompt = usePrompt();
  const [noteDraft, setNoteDraft] = useState("");
  const [noteAudience, setNoteAudience] = useState<"purchasing" | "customer">("purchasing");
  const [tlFilter, setTlFilter] = useState("all");
  const [busy, setBusy] = useState(false);

  // Picker option lists sourced from /api/assr/lookups/* exactly as the
  // desktop DetailContent does (issue categories by NAME; resolution +
  // priority by SLUG). Hardcoded constants stay as the pre-load fallback.
  const issueCatOptions = useLookupNames("issue-categories", ISSUE_CATEGORY_OPTIONS as readonly string[]);
  const resolutionOptions = useLookupSlugs("resolution-methods", RESOLUTION_OPTIONS as readonly string[]);
  const priorityOptions = useLookupSlugs("priorities", PRIORITY_OPTIONS as readonly string[]);
  const assignableUsers = useAssignableUsers();

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-assr-detail", id],
    queryFn: () => api.get<Any>(`/api/assr/${id}`),
    staleTime: 15_000,
  });

  const refetch = () => qc.invalidateQueries({ queryKey: ["mobile-assr-detail", id] });
  // A single mutual-exclusion guard keeps every write serial: no double
  // submits while a PATCH / transition / upload is in flight.
  const runWrite = async (fn: () => Promise<void>, failTitle: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      refetch();
      qc.invalidateQueries({ queryKey: ["mobile-assr-list"] });
    } catch (e: any) {
      await notify({ title: failTitle, body: e?.message || "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  // Section edit — patches only the fields the PATCH /:id endpoint accepts.
  const patchCase = (body: Record<string, any>, failTitle = "Couldn't save") =>
    runWrite(async () => {
      await api.patch(`/api/assr/${id}`, body);
    }, failTitle);

  const addNote = useMutation({
    mutationFn: (payload: { note: string; category: "purchasing" | "customer" }) =>
      api.post<Any>(`/api/assr/${id}/notes`, payload),
    onSuccess: () => {
      setNoteDraft("");
      refetch();
    },
  });

  const c: Any = data?.case ?? {};
  const items: Any[] = data?.items ?? [];
  const activity: Any[] = data?.activity ?? [];
  const attachments: Any[] = data?.attachments ?? [];
  const relatedPOs: Any[] = data?.related_pos ?? data?.relatedPos ?? [];
  const portalToken = get(data ?? {}, "portal_token", "portalToken");

  const sla = slaText(hoursToDeadline(c));
  const leadDays = get(c, "stageTargetDays", "stage_target_days");
  const resolutionMethod = get(c, "resolutionMethod", "resolution_method");
  const curStageIdx = STAGE_INDEX[stageOf(c)] ?? -1;

  // Timeline audience categories present on activity rows.
  const timelineCats = useMemo(() => {
    const set = new Set<string>();
    for (const a of activity) {
      const cat = String(get(a, "category") ?? "").toUpperCase();
      if (cat) set.add(cat);
    }
    return ["ALL", ...Array.from(set)];
  }, [activity]);
  const shownActivity = useMemo(() => {
    if (tlFilter === "all") return activity;
    return activity.filter((a) => String(get(a, "category") ?? "").toUpperCase() === tlFilter);
  }, [activity, tlFilter]);

  const assignedTo = get(c, "assignedToName", "assigned_to_name");

  // ── Change stage → POST /:id/transition (confirmed) ─────────────
  const changeStage = async () => {
    if (busy) return;
    const cur = stageOf(c);
    const target = await choose({
      title: "Change stage to",
      body: `Currently ${prettyStage(cur)}.`,
      options: STAGES.filter((s) => s.key !== cur).map((s) => ({ value: s.key, label: s.label })),
    });
    if (!target) return;
    const label = STAGES[STAGE_INDEX[target]]?.label ?? target;
    if (!(await confirm({ title: `Move to ${label}?`, confirmLabel: "Change stage" }))) return;
    await runWrite(async () => {
      await api.post(`/api/assr/${id}/transition`, { stage: target });
    }, "Stage change failed");
  };

  // ── Print copy → 3 variants via /api/assr-print/:id?variant= ────
  const printCopy = async () => {
    const variant = await choose({
      title: "Print copy",
      options: PRINT_VARIANTS.map((v) => ({ value: v.value, label: v.label })),
    });
    if (!variant) return;
    try {
      await api.openHtml(`/api/assr-print/${id}?variant=${variant}`);
    } catch (e: any) {
      await notify({ title: "Couldn't open print view", body: e?.message || "Please try again.", tone: "error" });
    }
  };

  // ── Add product item → POST /:id/items ──────────────────────────
  // In-app prompt for the item code (qty defaults to 1, matching the
  // endpoint's `qty ?? 1`). No naked window.prompt.
  const addItem = async () => {
    if (busy) return;
    const code = await prompt({
      title: "Add product item",
      placeholder: "e.g. AK-GUARDIAN MATT (K)",
      confirmLabel: "Add item",
      validate: (v) => (v.trim() ? null : "Enter an item code"),
    });
    if (code == null) return;
    const trimmed = code.trim();
    if (!trimmed) return;
    await runWrite(async () => {
      await api.post(`/api/assr/${id}/items`, { items: [{ item_code: trimmed, qty: 1 }] });
    }, "Couldn't add item");
  };

  // ── Remove product item → DELETE /:id/items/:itemId (desktop parity) ────────
  const removeItem = async (it: Any) => {
    if (busy) return;
    const itemId = Number(get(it, "id"));
    if (!itemId) return;
    const label = String(get(it, "itemCode", "item_code") ?? get(it, "itemDescription", "item_description") ?? "this item");
    if (!(await confirm({ title: `Remove ${label}?`, confirmLabel: "Remove", danger: true }))) return;
    await runWrite(async () => {
      await api.del(`/api/assr/${id}/items/${itemId}`);
    }, "Couldn't remove item");
  };

  // ── Assign PIC → PATCH /:id { assigned_to } (desktop parity) ────────────────
  // The picker is narrowed to Operations-department members, keeping the current
  // assignee selectable, exactly as the desktop DetailContent PIC select does.
  const assignPic = async () => {
    if (busy) return;
    const curId = Number(get(c, "assignedTo", "assigned_to") ?? 0) || null;
    const ops = assignableUsers.filter(
      (u) => /operation/i.test(u.department_name || "") || u.id === curId,
    );
    if (!ops.length) {
      await notify({ title: "No assignable users", body: "No Operations members are available to assign." });
      return;
    }
    const picked = await choose({
      title: "Assign to",
      body: assignedTo ? `Currently ${String(assignedTo)}.` : "Currently unassigned.",
      options: [
        { value: "", label: "— Unassigned —" },
        ...ops.map((u) => ({ value: String(u.id), label: u.name })),
      ],
    });
    if (picked == null) return;
    const nextId = picked === "" ? null : Number(picked);
    if (nextId === curId) return;
    await patchCase({ assigned_to: nextId }, "Couldn't reassign");
  };

  // ── Case-level values ──
  const poNo = get(c, "poNo", "po_no");
  const creditorCode = get(c, "creditorCode", "creditor_code");
  const archivedAt = get(c, "archivedAt", "archived_at");
  const isArchived = !!archivedAt;

  // ── Case archive → POST /:id/archive ────────────────────────────
  const archiveCase = async () => {
    if (busy || isArchived) return;
    if (
      !(await confirm({
        title: "Archive this case?",
        body: "It is hidden from the active list.",
        confirmLabel: "Archive",
        danger: true,
      }))
    )
      return;
    await runWrite(async () => {
      await api.post(`/api/assr/${id}/archive`);
    }, "Couldn't archive");
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* header (.hdr) — back + stage badge · eyebrow {case_no · priority} · customer */}
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Service Cases
          </button>
          {!isLoading && !error && (
            <span style={{ display: "flex", gap: 6, flex: "none" }}>
              {isArchived && <span className="badge b-grey">Archived</span>}
              <span className={`badge ${stageBadgeClass(stageOf(c))}`}>{prettyStage(stageOf(c))}</span>
            </span>
          )}
        </div>
        <div className="eyebrow tnum" style={{ marginTop: 7 }}>
          {String(caseNo(c))}{priorityOf(c) ? ` · ${cap(priorityOf(c))}` : ""}
        </div>
        <div className="scr-title">
          {customer(c)}
          {assignedTo ? <span style={{ fontSize: 11.5, fontWeight: 400, color: "var(--mut)" }}> · Assigned {String(assignedTo)}</span> : null}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 24 }}>
        {isLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load this case.</div>}
        {!isLoading && !error && (
          <>
            {/* chip row (.spill) */}
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
              <Spill colors={STAGE_PILL[stageOf(c)] ?? [FIELD_BG, MUTED]} dot>{prettyStage(stageOf(c))}</Spill>
              <Spill colors={PRIORITY_PILL[priorityOf(c)] ?? PRIORITY_PILL.normal}>{cap(priorityOf(c))}</Spill>
              {leadDays != null && <Spill colors={["#f3ece0", BROWN]}>Lead {Number(leadDays).toFixed(1)}d</Spill>}
              {resolutionMethod && <Spill colors={["#e2f0e9", GREEN]}>{resolutionLabel(String(resolutionMethod))}</Spill>}
              {sla?.overdue && <Spill colors={["#f8eaea", RED]}>{sla.label}</Spill>}
            </div>

            {/* Portal link (.tinybtn) — Print + Advance live in the actbar (spec) */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button
                onClick={async () => {
                  if (!portalToken) return;
                  const url = `${window.location.origin}/portal/case/${portalToken}`;
                  try {
                    if (navigator.clipboard) await navigator.clipboard.writeText(url);
                    await notify({ title: "Portal link copied", body: url });
                  } catch {
                    await notify({ title: "Portal link", body: url });
                  }
                }}
                disabled={!portalToken}
                className="tinybtn"
                style={{ flex: 1, padding: 9, opacity: portalToken ? 1 : 0.5 }}
              >
                Portal link
              </button>
            </div>

            {/* Workflow card — design VERBATIM framing (.card + "Workflow"
                label). Our real 9-stage pipeline stays tap-to-jump (POST
                /transition), so the dots keep the legend + interactivity. */}
            <div className="card"><div className="card-b">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span className="fld-l" style={{ marginBottom: 0 }}>Workflow</span>
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: "50%", background: GREEN }} /><span style={{ fontSize: 10, color: "var(--ink-2)" }}>Done</span></span>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: "50%", background: RED }} /><span style={{ fontSize: 10, color: "var(--ink-2)" }}>Current</span></span>
                </span>
              </div>
              <div className="hz-scroll" style={{ display: "flex", gap: 2, overflowX: "auto", paddingBottom: 4 }}>
                {STAGES.map((s, i) => {
                  const done = curStageIdx >= 0 && i < curStageIdx;
                  const current = i === curStageIdx;
                  const fg = done ? GREEN : current ? RED : MUTED;
                  const jump = async () => {
                    if (busy || current) return;
                    if (!(await confirm({ title: `Move to ${s.label}?`, confirmLabel: "Change stage" }))) return;
                    await runWrite(async () => {
                      await api.post(`/api/assr/${id}/transition`, { stage: s.key });
                    }, "Stage change failed");
                  };
                  return (
                    <div key={s.key} className="pstage" onClick={jump} style={{ cursor: busy || current ? "default" : "pointer" }}>
                      <span className="pdot" style={{
                        background: done ? GREEN : current ? RED : "#fff",
                        color: done || current ? "#fff" : GREY,
                        border: done || current ? "none" : `2px solid ${LINE}`,
                      }}>
                        {done ? (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span style={{ fontSize: 8.5, fontWeight: current ? 800 : 600, color: fg, lineHeight: 1.1 }}>{s.label}</span>
                    </div>
                  );
                })}
              </div>
            </div></div>

            {/* Reported issue banner — design VERBATIM (red box headline). Reads
                our real complaint_issue; the editable copy lives in Issue below. */}
            <div style={{ background: "#fbf2f2", border: "1px solid #f0d9d9", borderRadius: 12, padding: "12px 13px", marginBottom: 11 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", color: RED }}>Reported issue</div>
              <div style={{ fontSize: 12.5, color: "#3f2626", marginTop: 5, lineHeight: 1.5 }}>{issueOf(c) ? String(issueOf(c)) : "—"}</div>
            </div>

            {/* Issue (Edit → Save) */}
            <EditableAcc
              title="Issue"
              open
              busy={busy}
              fields={[
                { key: "complaint_issue", label: "Complaint", value: issueOf(c), type: "textarea" },
                { key: "issue_category", label: "Issue category", value: get(c, "issueCategory", "issue_category"), type: "select", options: issueCatOptions.map((o) => ({ value: o, label: o })) },
                { key: "priority", label: "Priority", value: priorityOf(c), type: "select", options: priorityOptions.map((o) => ({ value: o, label: cap(o) })) },
              ]}
              onSave={(body) => patchCase(body, "Couldn't save issue")}
            >
              <KV label="Status" value={statusOf(c) ? cap(statusOf(c).replace(/_/g, " ")) : "—"} />
            </EditableAcc>

            {/* Product & PO (design wording) */}
            <Acc
              title="Product & PO"
              open
              headSlot={
                <span
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) addItem(); }}
                  className="tinybtn"
                  style={{ marginLeft: "auto", color: BROWN, opacity: busy ? 0.5 : 1 }}
                >
                  + Add item
                </span>
              }
            >
              {items.length ? items.map((it, i) => (
                <div key={get(it, "id") ?? i} style={{ display: "flex", alignItems: "center", gap: 9, border: `1px solid #e3e6e0`, borderRadius: 10, padding: "10px 11px", marginBottom: 7 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="money" style={{ fontSize: 10, fontWeight: 700, color: BROWN }}>{String(get(it, "itemCode", "item_code") ?? "—")}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: INK, marginTop: 2 }}>{String(get(it, "itemDescription", "item_description") ?? "—")}</div>
                  </div>
                  <span style={{ fontSize: 11, color: MUTED }}>×{String(get(it, "qty") ?? 1)}</span>
                  <button
                    onClick={() => removeItem(it)}
                    disabled={busy}
                    aria-label="Remove item"
                    style={{ flex: "none", width: 26, height: 26, borderRadius: 8, border: "1px solid #e3e6e0", background: "#fff", color: RED, fontSize: 15, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
                  >
                    ×
                  </button>
                </div>
              )) : (
                <div style={{ fontSize: 12, color: GREY, padding: "2px 0" }}>No items recorded.</div>
              )}
              <KV label="PO No" value={relatedPOs.map((p) => String(get(p, "docNo", "doc_no") ?? "")).filter(Boolean).join(", ") || "—"} mono />
            </Acc>

            {/* Under Verification (brown left-border) — verification_outcome + verified_root_cause */}
            <EditableAcc
              title="Verification"
              open
              accent={BROWN}
              note="on receipt"
              busy={busy}
              fields={[
                { key: "verification_outcome", label: "Outcome", value: get(c, "verificationOutcome", "verification_outcome"), type: "select", options: [{ value: "", label: "Not verified yet" }, ...VERIFICATION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))] },
                { key: "verified_root_cause", label: "Root cause", value: get(c, "verifiedRootCause", "verified_root_cause"), type: "textarea" },
              ]}
              onSave={(body) => patchCase(body, "Couldn't save verification")}
            >
              {get(c, "verifiedByName", "verified_by_name") && (
                <div style={{ fontSize: 10.5, color: MUTED, background: FIELD_BG, borderRadius: 9, padding: "8px 10px", marginTop: 8 }}>
                  Verified by {String(get(c, "verifiedByName", "verified_by_name"))} · {dm(get(c, "verifiedAt", "verified_at"))}
                </div>
              )}
            </EditableAcc>

            {/* Resolution + supplier */}
            <EditableAcc
              title="Resolution"
              open
              busy={busy}
              fields={[
                { key: "resolution_method", label: "Resolution method", value: resolutionMethod, type: "select", options: [{ value: "", label: "—" }, ...resolutionOptions.map((o) => ({ value: o, label: resolutionLabel(o) }))] },
                { key: "action_remark", label: "Action remark", value: get(c, "actionRemark", "action_remark"), type: "textarea" },
                { key: "supplier_pickup_at", label: "Supplier pickup date", value: get(c, "supplierPickupAt", "supplier_pickup_at"), type: "date" },
              ]}
              onSave={(body) => patchCase(body, "Couldn't save resolution")}
            >
              {/* Supplier / creditor — read-only. */}
              <div className="fld-l" style={{ marginTop: 8 }}>Supplier</div>
              {creditorCode ? (
                <div style={{ display: "flex", alignItems: "center", gap: 9, border: `1px solid #e3e6e0`, borderRadius: 10, padding: "10px 11px", marginTop: 5 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{String(get(c, "creditorName", "creditor_name") ?? creditorCode)}</div>
                    <div className="money" style={{ fontSize: 10, color: GREY }}>{String(creditorCode)}</div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: GREY, marginTop: 5 }}>No supplier linked.</div>
              )}

              {/* Procurement / PO — read-only. */}
              <div className="fld-l" style={{ marginTop: 12 }}>PO No</div>
              <KV label="PO number" value={poNo ? String(poNo) : "—"} mono />
            </EditableAcc>

            {/* QC inspection (green left-border, "after repair") — inspection_result + items_ready_at */}
            <EditableAcc
              title="QC inspection"
              accent={GREEN}
              note="after repair"
              busy={busy}
              fields={[
                { key: "inspection_result", label: "QC result", value: get(c, "inspectionResult", "inspection_result"), type: "select", options: [{ value: "", label: "— none —" }, ...INSPECTION_OPTIONS.map((o) => ({ value: o, label: cap(o) }))] },
                { key: "items_ready_at", label: "QC inspection date", value: get(c, "itemsReadyAt", "items_ready_at"), type: "date" },
              ]}
              onSave={(body) => patchCase(body, "Couldn't save QC result")}
            >
              <div style={{ fontSize: 10, color: GREY, marginTop: 2 }}>Pass + date → becomes the Item Ready date. Fail → stays pending.</div>
            </EditableAcc>

            {/* Defect photos / videos → PUT /:id/attachments */}
            <PhotoGrid caseId={id} attachments={attachments} onChanged={refetch} notify={notify} confirm={confirm} />

            {/* Reference & logistics (Edit → Save) */}
            <EditableAcc
              title="Reference & logistics"
              busy={busy}
              fields={[
                { key: "ref_no", label: "Ref No", value: get(c, "refNo", "ref_no"), type: "text" },
                { key: "delivery_order", label: "Delivery order", value: get(c, "deliveryOrder", "delivery_order"), type: "text" },
                { key: "do_date", label: "DO date", value: get(c, "doDate", "do_date"), type: "date" },
              ]}
              onSave={(body) => patchCase(body, "Couldn't save reference")}
            />

            {/* Customer (Edit → Save, .pgrid2 read view) */}
            <EditableAcc
              title="Customer"
              open
              busy={busy}
              fields={[
                { key: "customer_name", label: "Customer", value: customer(c) === "—" ? "" : customer(c), type: "text" },
                { key: "phone", label: "Phone", value: get(c, "phone", "customerPhone", "customer_phone"), type: "text" },
                { key: "customer_email", label: "Email", value: get(c, "customerEmail", "customer_email"), type: "text" },
                { key: "location", label: "Location", value: get(c, "location", "customerState", "customer_state"), type: "text" },
                { key: "sales_agent", label: "Agent", value: get(c, "salesAgent", "sales_agent", "agent"), type: "text" },
              ]}
              onSave={(body) => patchCase(body, "Couldn't save customer")}
            >
              <div className="pgrid2">
                <PGrid label="SO No" value={String(get(c, "docNo", "doc_no") ?? "—")} mono />
                <PGrid label="Date" value={dm(get(c, "complainedDate", "complained_date", "createdAt", "created_at"))} />
              </div>
            </EditableAcc>

            {/* PIC — Assign (reassign assigned_to via PATCH /:id, desktop parity) */}
            <Acc
              title="PIC"
              open
              headSlot={
                <span
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) assignPic(); }}
                  className="tinybtn"
                  style={{ marginLeft: "auto", color: BROWN, opacity: busy ? 0.5 : 1 }}
                >
                  Assign
                </span>
              }
            >
              <KV label="Assigned to" value={assignedTo ? String(assignedTo) : "Unassigned"} />
              <KV label="Created by" value={String(get(c, "createdByName", "created_by_name") ?? "—")} />
            </Acc>

            {/* SLA banner */}
            <div style={{ background: sla?.overdue ? "#f8eaea" : FIELD_BG, border: `1px solid ${sla?.overdue ? "#f0d4d4" : "#e3e6e0"}`, borderRadius: 13, padding: "12px 14px", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={sla?.overdue ? RED : MUTED} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: sla?.overdue ? RED : MUTED }}>SLA</span>
              </div>
              <div style={{ fontSize: 12, color: sla?.overdue ? "#7a2222" : "var(--ink-2)", marginTop: 5 }}>
                Deadline {dm(get(c, "deadlineAt", "deadline_at"))} · {cap(priorityOf(c))}
              </div>
              {sla && (
                <div style={{ fontSize: 15, fontWeight: 800, color: sla.overdue ? RED : GREEN, marginTop: 2 }}>{sla.label}</div>
              )}
            </div>

            {/* Timeline (.pacc) with audience chips + add-note + rbadge rows */}
            <Acc title="Timeline" open>
              {timelineCats.length > 1 && (
                <div className="hz-scroll" style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 6, paddingBottom: 2 }}>
                  {timelineCats.map((cat) => {
                    const key = cat === "ALL" ? "all" : cat;
                    return (
                      <button key={cat} className={`sochip${tlFilter === key ? " on" : ""}`} onClick={() => setTlFilter(key)}>
                        {cat === "ALL" ? "All" : cap(cat.toLowerCase())}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* audience picker — the /:id/notes endpoint accepts purchasing | customer */}
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {NOTE_AUDIENCE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => setNoteAudience(o.value)}
                    className={`sochip${noteAudience === o.value ? " on" : ""}`}
                    style={{ flex: 1 }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {/* add note input */}
              <div style={{ display: "flex", gap: 7, marginBottom: 4 }}>
                <input
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder={noteAudience === "customer" ? "Add a customer-visible note" : "Add an internal note"}
                  className="fld-i"
                  style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}
                />
                <button
                  onClick={() => noteDraft.trim() && addNote.mutate({ note: noteDraft.trim(), category: noteAudience })}
                  disabled={!noteDraft.trim() || addNote.isPending}
                  style={{ flex: "none", padding: "0 14px", borderRadius: 9, border: "none", background: noteDraft.trim() ? BROWN : "#c9c1b4", color: "#fff", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: noteDraft.trim() ? "pointer" : "default" }}
                >
                  {addNote.isPending ? "…" : "Add"}
                </button>
              </div>
              <div style={{ fontSize: 10, color: GREY, marginBottom: 10 }}>
                {noteAudience === "customer" ? "Visible to the customer on the portal." : "Internal only — hidden from the customer."}
              </div>
              {addNote.isError && <div style={{ fontSize: 11, color: RED, marginBottom: 8 }}>Couldn't add the note. Try again.</div>}
              {shownActivity.length ? shownActivity.map((a, i) => {
                const cat = String(get(a, "category") ?? "").toUpperCase();
                const label = get(a, "note", "toValue", "to_value", "action") ?? "Update";
                const who = get(a, "userName", "user_name") ?? "System";
                const badge = catBadge(cat);
                return (
                  <div key={get(a, "id") ?? i} style={{ display: "flex", gap: 10, padding: "10px 0", borderTop: `1px solid #eceee9` }}>
                    <span style={{ width: 9, height: 9, flex: "none", borderRadius: "50%", border: "2px solid #c2c6bd", marginTop: 3 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 10, color: GREY }}>{dtm(get(a, "createdAt", "created_at"))}</div>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginTop: 1 }}>{String(label)}</div>
                      <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 3 }}>
                        <span>by {String(who)}</span>
                        {cat && (
                          <span className="rbadge" style={{ background: badge[0], color: badge[1], marginLeft: 3 }}>{cat}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }) : (
                <div style={{ fontSize: 12, color: GREY, padding: "8px 0" }}>No timeline entries.</div>
              )}
            </Acc>
          </>
        )}
      </div>

      {/* actbar (spec #service-detail) — Archive/Print (ghost) + Advance (primary). */}
      <footer className="actbar" style={{ display: "flex", gap: 9 }}>
        <button onClick={archiveCase} disabled={busy || isLoading || !!error || isArchived} className="btn-ghost" style={{ flex: 1, opacity: busy || isLoading || error || isArchived ? 0.5 : 1 }}>Archive</button>
        <button onClick={printCopy} disabled={isLoading || !!error} className="btn-ghost" style={{ flex: 1, opacity: isLoading || error ? 0.5 : 1 }}>Print</button>
        <button onClick={changeStage} disabled={busy || isLoading || !!error || isArchived} className="btn" style={{ flex: 1.4, opacity: busy || isLoading || error || isArchived ? 0.5 : 1 }}>Advance stage →</button>
      </footer>
    </div>
  );
}

// ── NEW CASE SHEET (#service-new) ─────────────────────────────────
// The backend requires doc_no (SO), at least one item (item_code), and
// complaint_issue; issue_category + priority are optional. Customer +
// supplier are resolved server-side from the SO. The design shows a
// "SO # / reference / customer" lookup + item; we keep both fields wired.
function NewCaseSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (id: number) => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  // Lookups sourced the SAME way desktop CreatePanel does — from
  // /api/assr/lookups/*, which returns { data: [{ slug, name, ... }] }.
  // Issue categories render by NAME; priority by SLUG. Fall back to the
  // hardcoded constants until the call returns so the form stays usable.
  const issueCatOptions = useLookupNames("issue-categories", ISSUE_CATEGORY_OPTIONS as readonly string[]);
  const priorityOptions = useLookupSlugs("priorities", PRIORITY_OPTIONS as readonly string[]);
  const [docNo, setDocNo] = useState("");
  // SO picker (real search-so lookup, replacing free-text). `soQuery` is
  // what the user types; once they pick a hit we lock `docNo` and show the
  // chosen SO. `soPicked` guards the dropdown so it hides after selection.
  const [soQuery, setSoQuery] = useState("");
  const [soPicked, setSoPicked] = useState<SoHit | null>(null);
  const { results: soResults, loading: soLoading } = useSoSearch(soPicked ? "" : soQuery);
  const [itemCode, setItemCode] = useState("");
  const [complaint, setComplaint] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("normal");
  // SO line-item lookup — once an SO is chosen, offer its items so the
  // Product field is a picker (GET /api/assr/lookup-items/:docNo), not free
  // text. Staff can still type a custom code if the item isn't listed.
  const { data: soItemsData } = useQuery({
    queryKey: ["mobile-assr-so-items", docNo],
    enabled: !!docNo,
    staleTime: 60_000,
    queryFn: () => api.get<{ items?: Any[] }>(`/api/assr/lookup-items/${encodeURIComponent(docNo)}`),
  });
  const soItems: Any[] = soItemsData?.items ?? [];

  const pickSo = (hit: SoHit) => {
    setSoPicked(hit);
    setDocNo(String(get(hit, "docNo", "doc_no") ?? "").trim());
    setSoQuery("");
  };
  const clearSo = () => { setSoPicked(null); setDocNo(""); setSoQuery(""); };
  // Defect photos/videos staged locally, uploaded after the case is
  // created (attachments require the case id). Up to 5, matching the design.
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter((f) =>
      ATTACH_EXTS.has((f.name.split(".").pop() || "").toLowerCase()),
    );
    e.target.value = "";
    setFiles((prev) => [...prev, ...picked].slice(0, 5));
  };

  const create = useMutation({
    mutationFn: async () => {
      // Match desktop CreatePanel EXACTLY: POST /api/assr (NO trailing
      // slash — the slash 404s) with an `items` array of
      // { item_code, item_description, qty }, NOT a singular `item_code`
      // string. Backend accepts both, but keeping the shape identical to
      // desktop guarantees a mobile-created case lands the same rows and
      // shows up on desktop (owner's acceptance test).
      const res = await api.post<{ id: number; assr_no?: string }>("/api/assr", {
        doc_no: docNo.trim(),
        items: itemCode.trim()
          ? [{ item_code: itemCode.trim(), item_description: null, qty: 1 }]
          : [],
        complaint_issue: complaint.trim(),
        issue_category: category.trim() || null,
        priority,
      });
      const id = Number(get(res ?? {}, "id"));
      // Upload staged defect photos/videos as "complaint" attachments.
      if (id && files.length) {
        setUploadProgress({ done: 0, total: files.length });
        let failed = 0;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          try {
            const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
            const buf = await file.arrayBuffer();
            await api.putBinary(
              `/api/assr/${id}/attachments?category=complaint&ext=${ext}&name=${encodeURIComponent(file.name)}`,
              buf,
              file.type || "application/octet-stream",
            );
          } catch {
            failed++;
          }
          setUploadProgress({ done: i + 1, total: files.length });
        }
        setUploadProgress(null);
        if (failed) await notify({ title: "Case created", body: `${failed} of ${files.length} files failed to upload.`, tone: "error" });
      }
      return res;
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["mobile-assr-list"] });
      const id = Number(get(res ?? {}, "id"));
      onClose();
      if (id) onOpen(id);
    },
  });

  const valid = docNo.trim() && itemCode.trim() && complaint.trim();

  return (
    <div className="hz-m" style={{ position: "absolute", inset: 0, zIndex: 20, background: "rgba(17,20,15,.4)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--app-bg)", borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: "92%", display: "flex", flexDirection: "column", paddingBottom: "env(safe-area-inset-bottom)" }}>
        {/* header (.hdr) — back "Cancel" + title (spec #service-new) */}
        <header className="hdr" style={{ borderTopLeftRadius: 18, borderTopRightRadius: 18 }}>
          <div className="hdr-row">
            <button className="back" onClick={onClose}>
              <span className="chev">‹</span> Cancel
            </button>
          </div>
          <div className="scr-title">New Service Case</div>
        </header>

        <div className="scroll hz-scroll" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 11 }}>
          {/* Customer / SO + Product + Issue card (.card) */}
          <div className="card"><div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {/* SO picker — real search-so lookup, not free text. */}
            <div className="fld" style={{ position: "relative" }}>
              <span className="fld-l">Customer / SO lookup *</span>
              {soPicked ? (
                <div style={{ display: "flex", alignItems: "center", gap: 9, border: `1px solid ${TEAL}`, borderRadius: 10, padding: "9px 11px", background: FIELD_BG }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="money" style={{ fontSize: 12, fontWeight: 700, color: INK }}>{String(get(soPicked, "docNo", "doc_no"))}</div>
                    <div style={{ fontSize: 11, color: MUTED, ...cellEllipsis }}>{String(get(soPicked, "debtorName", "debtor_name") ?? "—")}</div>
                  </div>
                  <button onClick={clearSo} aria-label="Change SO" className="tinybtn" style={{ flex: "none", padding: "3px 9px" }}>Change</button>
                </div>
              ) : (
                <>
                  <input value={soQuery} onChange={(e) => setSoQuery(e.target.value)} placeholder="Search SO no or customer (2+ chars)" className="fld-i money" />
                  {soQuery.trim().length >= 2 && (
                    <div style={{ marginTop: 5, border: `1px solid #e3e6e0`, borderRadius: 10, overflow: "hidden", maxHeight: 190, overflowY: "auto" }} className="hz-scroll">
                      {soLoading && <div style={{ fontSize: 11, color: GREY, padding: "9px 11px" }}>Searching…</div>}
                      {!soLoading && !soResults.length && <div style={{ fontSize: 11, color: GREY, padding: "9px 11px" }}>No matching sales orders.</div>}
                      {soResults.map((hit, i) => (
                        <button
                          key={String(get(hit, "docNo", "doc_no")) + i}
                          onClick={() => pickSo(hit)}
                          style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderTop: i ? "1px solid #eceee9" : "none", background: "#fff", padding: "9px 11px", cursor: "pointer" }}
                        >
                          <div className="money" style={{ fontSize: 12, fontWeight: 700, color: INK }}>{String(get(hit, "docNo", "doc_no"))}</div>
                          <div style={{ fontSize: 11, color: MUTED, ...cellEllipsis }}>{String(get(hit, "debtorName", "debtor_name") ?? "—")}{get(hit, "phone") ? ` · ${String(get(hit, "phone"))}` : ""}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            {/* Product — SO line-item picker when the SO is known; free text otherwise. */}
            <label className="fld">
              <span className="fld-l">Product *</span>
              {soItems.length ? (
                <select value={itemCode} onChange={(e) => setItemCode(e.target.value)} className="fld-i money">
                  <option value="">— select item —</option>
                  {soItems.map((it, i) => {
                    const code = String(get(it, "itemCode", "item_code") ?? "");
                    const desc = get(it, "itemDescription", "item_description");
                    return <option key={code + i} value={code}>{code}{desc ? ` — ${String(desc)}` : ""}</option>;
                  })}
                </select>
              ) : (
                <input value={itemCode} onChange={(e) => setItemCode(e.target.value)} placeholder="Affected item code — e.g. AK-GUARDIAN MATT (K)" className="fld-i money" />
              )}
            </label>
            <div className="fld-row">
              <label className="fld">
                <span className="fld-l">Issue category *</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="fld-i">
                  <option value="">— select —</option>
                  {issueCatOptions.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </label>
              <label className="fld">
                <span className="fld-l">Priority *</span>
                <select value={priority} onChange={(e) => setPriority(e.target.value)} className="fld-i">
                  {priorityOptions.map((o) => (
                    <option key={o} value={o}>{cap(o)}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="fld">
              <span className="fld-l">Issue description *</span>
              <textarea value={complaint} onChange={(e) => setComplaint(e.target.value)} rows={3} placeholder="Describe the defect / fault" className="fld-i" style={{ resize: "none" }} />
            </label>
          </div></div>

          {/* Attachments (.card) — up to 5, uploaded after create */}
          <div className="card">
            <div className="card-h">
              <span className="card-t">Attachments</span>
              <span className="card-sub">{files.length} / 5</span>
            </div>
            <div className="card-b">
              {files.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7, marginBottom: 10 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: FIELD_BG, border: `1px solid #e3e6e0`, display: "flex", alignItems: "center", justifyContent: "center", padding: 4 }}>
                      <span style={{ fontSize: 9, color: MUTED, textAlign: "center", wordBreak: "break-word", lineHeight: 1.2 }}>{f.name}</span>
                      <button
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        aria-label="Remove file"
                        style={{ position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(17,20,15,.55)", color: "#fff", fontSize: 13, lineHeight: 1, cursor: "pointer" }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {files.length < 5 && (
                <label style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, border: "1px dashed var(--mut2)", borderRadius: 11, padding: 18, background: "var(--bg)", cursor: "pointer" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={TEAL} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--brand)" }}>Add photo / video / PDF</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf" multiple style={{ display: "none" }} onChange={onPickFiles} />
                </label>
              )}
              <div style={{ fontSize: 10, color: "var(--mut2)", marginTop: 7, textAlign: "center" }}>JPG / PNG / WEBP / MP4 / PDF · 5MB each · up to 5</div>
            </div>
          </div>

          {create.isError && <div style={{ fontSize: 12, color: "var(--red)" }}>Couldn't create the case. Check the SO number and try again.</div>}
        </div>

        {/* actbar (.actbar / .btn) */}
        <footer className="actbar">
          <button
            onClick={() => valid && create.mutate()}
            disabled={!valid || create.isPending}
            className="btn"
            style={{ background: valid ? TEAL : "#c9c1b4", cursor: valid ? "pointer" : "default" }}
          >
            {create.isPending
              ? uploadProgress
                ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                : "Creating…"
              : "Create case"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── shared inline helpers ─────────────────────────────────────────
const cellEllipsis: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// ── small building blocks ─────────────────────────────────────────

// .pacc accordion (native <details>) — brown uppercase .psec-t title, chevron,
// optional left accent border, optional right note / slot.
function Acc({
  title,
  children,
  open,
  accent,
  note,
  headRight,
  headSlot,
}: {
  title: string;
  children: React.ReactNode;
  open?: boolean;
  accent?: string;
  note?: string;
  headRight?: string;
  headSlot?: React.ReactNode;
}) {
  return (
    <details className="pacc" open={open} style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <summary>
        <span className="psec-t">{title}</span>
        {note && <span style={{ marginLeft: "auto", fontSize: 10, color: GREY }}>{note}</span>}
        {headRight && <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: INK }}>{headRight}</span>}
        {headSlot}
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: note || headRight || headSlot ? 0 : "auto" }}><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">{children}</div>
    </details>
  );
}

// key/value row inside an accordion.
function KV({ label, value, multiline, mono }: { label: string; value: string; multiline?: boolean; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderTop: `1px solid #f4f5f2` }}>
      <span style={{ fontSize: 11, color: MUTED, flex: "none" }}>{label}</span>
      <span className={mono ? "money" : undefined} style={{ fontSize: 12.5, fontWeight: 600, color: INK, textAlign: "right", whiteSpace: multiline ? "normal" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</span>
    </div>
  );
}

// .pgrid2 cell (.pkv-l label above .pkv-v value).
function PGrid({ label, value, mono, span, multiline }: { label: string; value: string; mono?: boolean; span?: boolean; multiline?: boolean }) {
  return (
    <div style={span ? { gridColumn: "1 / -1" } : undefined}>
      <div className="pkv-l">{label}</div>
      <div className={`pkv-v${mono ? " money" : ""}`} style={{ lineHeight: multiline ? 1.4 : undefined, fontSize: multiline ? 12 : undefined, fontWeight: multiline ? 600 : undefined, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

// two-up cell (.fld-l micro-label above the value).
function KVcell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="fld-l">{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: INK, marginTop: 2, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

// .spill status pill (list + detail chip row). Colours are dynamic → inline.
function Spill({ colors, dot, children }: { colors: [string, string]; dot?: boolean; children: React.ReactNode }) {
  return (
    <span className="spill" style={{ background: colors[0], color: colors[1], fontSize: 10, padding: "4px 9px", borderRadius: 20 }}>
      {dot && <span style={{ marginRight: 4 }}>●</span>}
      {children}
    </span>
  );
}

// timeline audience badge colour (rbadge — 12% tint of the category hue).
function catBadge(cat: string): [string, string] {
  switch (cat) {
    case "PURCHASING": return ["#a16a2e1f", BROWN];
    case "CUSTOMER": return ["#2f8a5b1f", GREEN];
    case "SERVICE ADMIN": return ["#16695f1f", TEAL];
    default: return ["#16695f1f", TEAL];
  }
}

// ── Editable accordion (Edit → Save) ──────────────────────────────
// Read view mirrors the design's KV rows; tapping "Edit" swaps in the
// field inputs + a Save/Cancel actbar. Save posts ONLY the changed
// fields (dropping unchanged ones) so PATCH /:id never rewrites a
// column the user didn't touch. All values are strings; "" is sent as
// null-equivalent (the endpoint stores `?? null`).
type EditField = {
  key: string;
  label: string;
  value: any;
  type: "text" | "textarea" | "date" | "select";
  options?: { value: string; label: string }[];
};

function EditableAcc({
  title,
  fields,
  onSave,
  busy,
  open,
  accent,
  note,
  children,
}: {
  title: string;
  fields: EditField[];
  onSave: (body: Record<string, any>) => Promise<void>;
  busy: boolean;
  open?: boolean;
  accent?: string;
  note?: string;
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of fields) {
      const v = f.type === "date" ? isoDateOnly(f.value) : f.value;
      m[f.key] = v == null ? "" : String(v);
    }
    return m;
  }, [fields]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);

  const startEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraft(initial);
    setEditing(true);
  };
  const cancel = () => setEditing(false);
  const save = async () => {
    const body: Record<string, any> = {};
    for (const f of fields) {
      const next = (draft[f.key] ?? "").trim();
      if (next !== (initial[f.key] ?? "")) body[f.key] = next === "" ? null : next;
    }
    if (Object.keys(body).length === 0) { setEditing(false); return; }
    await onSave(body);
    setEditing(false);
  };

  return (
    <details className="pacc" open={open || editing} style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <summary>
        <span className="psec-t">{title}</span>
        {note && !editing && <span style={{ marginLeft: "auto", fontSize: 10, color: GREY, marginRight: 8 }}>{note}</span>}
        {!editing && (
          <span onClick={startEdit} className="tinybtn" style={{ marginLeft: note ? 0 : "auto" }}>Edit</span>
        )}
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        {editing ? (
          <>
            {fields.map((f) => (
              <label key={f.key} className="fld">
                <span className="fld-l">{f.label}</span>
                {f.type === "textarea" ? (
                  <textarea
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    rows={3}
                    className="fld-i"
                    style={{ resize: "none" }}
                  />
                ) : f.type === "select" ? (
                  <select
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="fld-i"
                  >
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === "date" ? "date" : "text"}
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="fld-i"
                  />
                )}
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button onClick={cancel} disabled={busy} className="tinybtn" style={{ flex: 1, padding: 9 }}>Cancel</button>
              <button
                onClick={save}
                disabled={busy}
                className="tinybtn"
                style={{ flex: 1, padding: 9, background: TEAL, borderColor: TEAL, color: "#fff", opacity: busy ? 0.6 : 1 }}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        ) : (
          <>
            {fields.map((f) => (
              <KV key={f.key} label={f.label} value={fieldDisplay(f)} multiline={f.type === "textarea"} />
            ))}
            {children}
          </>
        )}
      </div>
    </details>
  );
}

// Read-view rendering for an EditField (date formatting, select label,
// dash for empty).
function fieldDisplay(f: EditField): string {
  const raw = f.value;
  if (raw == null || raw === "") return "—";
  if (f.type === "date") return dm(raw);
  if (f.type === "select") {
    const opt = (f.options ?? []).find((o) => o.value === String(raw));
    return opt ? opt.label : String(raw);
  }
  return String(raw);
}

// A YYYY-MM-DD slice for <input type="date">; tolerates ISO / date-only.
function isoDateOnly(v: any): string {
  if (!v) return "";
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const dt = new Date(s);
  if (isNaN(+dt)) return "";
  return dt.toISOString().slice(0, 10);
}

// ── Defect photos / videos grid → PUT /:id/attachments ────────────
// Shows every non-archived attachment as an auth-fetched thumbnail
// (blob URL) and lets staff capture / pick up to 5 more per batch.
// Each file streams to the raw-binary PUT endpoint (?category&ext&name);
// archive routes through the in-app confirm dialog (no naked delete).
function PhotoGrid({
  caseId,
  attachments,
  onChanged,
  notify,
  confirm,
}: {
  caseId: number;
  attachments: Any[];
  onChanged: () => void;
  notify: ReturnType<typeof useNotify>;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!picked.length) return;
    const files = picked.slice(0, 5);
    // Guard extensions client-side to match the server allow-list.
    const rejected = files.filter((f) => !ATTACH_EXTS.has((f.name.split(".").pop() || "").toLowerCase()));
    const accepted = files.filter((f) => ATTACH_EXTS.has((f.name.split(".").pop() || "").toLowerCase()));
    if (!accepted.length) {
      await notify({ title: "Unsupported file", body: "Allowed: JPG, PNG, WEBP, MP4, PDF.", tone: "error" });
      return;
    }
    setUploading({ done: 0, total: accepted.length });
    let failed = 0;
    for (let i = 0; i < accepted.length; i++) {
      const file = accepted[i];
      try {
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const buf = await file.arrayBuffer();
        await api.putBinary(
          `/api/assr/${caseId}/attachments?category=complaint&ext=${ext}&name=${encodeURIComponent(file.name)}`,
          buf,
          file.type || "application/octet-stream",
        );
      } catch {
        failed++;
      }
      setUploading({ done: i + 1, total: accepted.length });
    }
    setUploading(null);
    onChanged();
    if (failed || rejected.length) {
      await notify({
        title: failed ? "Some uploads failed" : "Some files skipped",
        body: `${accepted.length - failed} uploaded${failed ? `, ${failed} failed` : ""}${rejected.length ? `, ${rejected.length} unsupported skipped` : ""}.`,
        tone: failed ? "error" : "info",
      });
    }
  };

  const archive = async (att: Any) => {
    const attId = Number(get(att, "id"));
    if (!attId) return;
    if (!(await confirm({ title: "Remove this file?", confirmLabel: "Remove", danger: true }))) return;
    try {
      await api.post(`/api/assr/attachments/${attId}/archive`);
      onChanged();
    } catch (e: any) {
      await notify({ title: "Couldn't remove file", body: e?.message || "Please try again.", tone: "error" });
    }
  };

  return (
    <Acc
      title="Defect photos / videos"
      open
      headRight={`${attachments.length}`}
    >
      {attachments.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7, marginBottom: 10 }}>
          {attachments.map((att, i) => (
            <AttachThumb key={get(att, "id") ?? i} att={att} onArchive={() => archive(att)} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: GREY, padding: "2px 0 10px" }}>No photos or videos yet.</div>
      )}
      <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, background: TEAL, borderRadius: 13, padding: 13, cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.6 : 1 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#fff" }}>
          {uploading ? `Uploading ${uploading.done}/${uploading.total}…` : "Add photos / videos"}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf"
          multiple
          style={{ display: "none" }}
          disabled={!!uploading}
          onChange={onPick}
        />
      </label>
      <div style={{ fontSize: 10, color: GREY, marginTop: 6 }}>Up to 5 per batch · JPG / PNG / WEBP / MP4 / PDF.</div>
    </Acc>
  );
}

// Auth-fetched attachment thumbnail (blob URL) with a remove affordance.
function AttachThumb({ att, onArchive }: { att: Any; onArchive: () => void }) {
  const key = get(att, "r2Key", "r2_key");
  const contentType = String(get(att, "contentType", "content_type") ?? "");
  const isVideo = contentType.startsWith("video");
  const isPdf = contentType.includes("pdf");
  const [url, setUrl] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["mobile-assr-att", key],
    enabled: !!key && !isVideo && !isPdf,
    staleTime: 5 * 60_000,
    queryFn: () => api.fetchBlobUrl(`/api/assr/attachments/${key}`),
  });
  if (data && data !== url) setUrl(data);

  return (
    <div style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: FIELD_BG, border: `1px solid #e3e6e0` }}>
      {isVideo || isPdf ? (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: MUTED }}>{isVideo ? "VIDEO" : "PDF"}</span>
        </div>
      ) : url ? (
        <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 9, color: GREY }}>…</span>
        </div>
      )}
      <button
        onClick={onArchive}
        aria-label="Remove file"
        style={{ position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(17,20,15,.55)", color: "#fff", fontSize: 13, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        ×
      </button>
    </div>
  );
}
