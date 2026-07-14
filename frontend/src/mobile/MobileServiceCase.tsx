import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { MobileVirtualList } from "./MobileVirtualList";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useChoice } from "../vendor/scm/components/ChoiceDialog";
import { todayMyt } from "../vendor/scm/lib/dates";
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
// 2026-07-14 redesign (service-case-mobile handoff): the list is "Status
// Cards" (priority stripe + SLA pill + mini 8-step progress) and the
// detail is TABBED — Overview / Stage / Info / Timeline. "Stage" shows
// the 8-stage workflow grouped into Intake / Repair / Return phases;
// tapping a stage chip jumps to Info with that stage's accordion open.
// Inspection is no longer a stage (mig 0105): Inspect by + the QC-issue
// fields live inside Under Verification.

type Any = Record<string, any>;

// ── Theme C colour tokens (design SC_T) ───────────────────────────
const INK = "#11140f";
const INK_SEC = "#3f463a";
const MUTED = "#767b6e";
const TEAL = "#16695f";
const TEAL_DK = "#0c3f39";
const BROWN = "#a16a2e";
const BROWN_SOFT = "#f6efd9";
const BROWN_FG = "#8a6a2e";
const GREEN = "#2f8a5b";
const OK_BG = "#e2f0e9";
const WARN = "#B76B00";
const WARN_BG = "rgba(183,107,0,0.12)";
const RED = "#b23a3a";
const ERR_BG = "rgba(178,58,58,0.08)";
const GREY = "#9aa093";
const LINE = "#d6d9d2";
const LINE_SOFT = "rgba(34,31,32,0.10)";
const DIM = "#e3e6e0";
const FIELD_BG = "#f4f6f3";

// Ordered stage pipeline (backend ALL_STAGES) — 8 stages since mig 0105
// retired Pending Inspection. `label` is the chip-short form, `long` the
// card/badge form; `owner` mirrors ServiceProgressTracker's owner map.
const STAGES: { key: string; label: string; long: string; owner: string }[] = [
  { key: "pending_review",           label: "Review",      long: "Pending Review",              owner: "Service Admin" },
  { key: "under_verification",       label: "Verify",      long: "Under Verification",          owner: "Service Admin" },
  { key: "pending_solution",         label: "Solution",    long: "Pending Solution",            owner: "Service Admin" },
  { key: "pending_item_pickup",      label: "Item Pickup", long: "Pending Item Pickup",         owner: "Logistic Admin" },
  { key: "pending_supplier_pickup",  label: "Supplier",    long: "Pending Supplier Pickup",     owner: "Service Admin" },
  { key: "pending_item_ready",       label: "Item Ready",  long: "Pending Item Ready",          owner: "Service Admin" },
  { key: "pending_delivery_service", label: "Delivery",    long: "Pending Delivery / Service",  owner: "Logistic Admin" },
  { key: "completed",                label: "Completed",   long: "Completed",                   owner: "System" },
];
const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
// Stage-tab grouping (design StagePhases): Intake / Repair / Return.
const PHASES: { name: string; idx: number[] }[] = [
  { name: "Intake", idx: [0, 1, 2] },
  { name: "Repair", idx: [3, 4, 5] },
  { name: "Return", idx: [6, 7] },
];

// ── Enum option lists (mirrors desktop ServiceCases.tsx) ──────────
// PATCH /:id accepts these column values; the mobile edit controls write
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
// QC result values shared by qc_issue_result (on receipt, mig 0105) and
// inspection_result (after repair, v3.1).
const QC_RESULT_OPTIONS = [
  { value: "pass", label: "Pass" },
  { value: "fail", label: "Fail" },
  { value: "na", label: "N/A" },
] as const;
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
const ATTACH_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,application/pdf";

// Priority meta — design SC_PRIORITY (Theme C hues).
const PRIORITY_META: Record<string, { label: string; color: string }> = {
  low: { label: "Low", color: GREY },
  normal: { label: "Normal", color: TEAL },
  high: { label: "High", color: WARN },
  urgent: { label: "Urgent", color: "#B71C1C" },
};

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

// SLA state for the list pills / detail banner (design SC_slaState).
type SlaTone = "breach" | "risk" | "ok" | "done";
const SLA_TONE: Record<SlaTone, { fg: string; bg: string }> = {
  breach: { fg: RED, bg: "#f8eaea" },
  risk: { fg: WARN, bg: WARN_BG },
  ok: { fg: GREEN, bg: OK_BG },
  done: { fg: GREY, bg: FIELD_BG },
};
const slaStateOf = (r: Any): { tone: SlaTone; label: string } => {
  if (stageOf(r) === "completed") return { tone: "done", label: "Closed" };
  const h = hoursToDeadline(r);
  if (h == null || !isFinite(h)) return { tone: "ok", label: "No SLA" };
  if (h < 0) {
    const days = Math.floor(-h / 24);
    return { tone: "breach", label: days >= 1 ? `${days}d overdue` : `${Math.abs(Math.round(h))}h overdue` };
  }
  if (h < 24) return { tone: "risk", label: `Due in ${Math.round(h)}h` };
  return { tone: "ok", label: `Due in ${Math.floor(h / 24)}d` };
};

// ── Lookup option hooks (mirror desktop) ──────────────────────────
// The assr pickers live behind /api/assr/lookups/:kind, which returns
// { data: [{ id, slug, name, sort_order, active }] }. Desktop reads
// issue-categories by `name` and resolution-methods / priorities by
// `slug`. We do the same, falling back to the hardcoded constant until
// the (cheap, cached) call returns so the form stays usable.
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
  return idx != null ? STAGES[idx].long : cap(stage.replace(/_/g, " ")) || "—";
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
// Human overdue / due-in from hours-to-deadline (drives the SLA banner).
const slaText = (h: number | null): { label: string; overdue: boolean } | null => {
  if (h == null || !isFinite(h)) return null;
  if (h < 0) {
    const days = Math.floor(-h / 24);
    return { label: days >= 1 ? `${days} days overdue` : `Overdue ${Math.abs(Math.round(h))}h`, overdue: true };
  }
  const days = Math.floor(h / 24);
  return { label: days >= 1 ? `Due in ${days} days` : `Due in ${Math.round(h)}h`, overdue: false };
};

/** Mobile Service Case (ASSR) — Status Cards list + tabbed detail
 *  (Overview / Stage / Info / Timeline) + new-case sheet, all wired to
 *  the core /api/assr backend. */
export function MobileServiceCase({ onBack, startNew = false }: { onBack?: () => void; startNew?: boolean }) {
  const [openId, setOpenId] = useState<number | null>(null);
  // `startNew` (from the Orders FAB "+ New Service Case") opens the create sheet
  // straight away.
  const [showNew, setShowNew] = useState(startNew);

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

// ── LIST — "Status Cards" (design ListA) ──────────────────────────
function CaseList({
  onBack,
  onOpen,
  onNew,
}: {
  onBack?: () => void;
  onOpen: (id: number) => void;
  onNew: () => void;
}) {
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("all");
  const [sort, setSort] = useState<"sla" | "no">("sla");

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-assr-list"],
    queryFn: () => api.get<{ data?: Any[] }>("/api/assr?per_page=200"),
    staleTime: 30_000,
  });
  const all = data?.data ?? [];

  const isMine = (r: Any) => {
    const uid = user?.id;
    if (!uid) return false;
    return Number(get(r, "assignedTo", "assigned_to") ?? 0) === uid
      || Number(get(r, "assignedTo2", "assigned_to_2") ?? 0) === uid;
  };

  // Design chips (ListA): All / SLA risk / Urgent / Mine, with counts.
  const CHIPS: { key: string; label: string; match: (r: Any) => boolean }[] = [
    { key: "all", label: "All", match: () => true },
    { key: "risk", label: "SLA risk", match: (r) => ["breach", "risk"].includes(slaStateOf(r).tone) },
    { key: "urgent", label: "Urgent", match: (r) => priorityOf(r) === "urgent" },
    { key: "mine", label: "Mine", match: isMine },
  ];

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const ch of CHIPS) c[ch.key] = all.filter(ch.match).length;
    return c;
  }, [all, user?.id]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const active = CHIPS.find((c) => c.key === chip) ?? CHIPS[0];
    let out = all.filter((r) => {
      if (!active.match(r)) return false;
      if (needle) {
        // Search covers case no / SO / Ref / customer / issue / item.
        const hay = `${customer(r)} ${caseNo(r)} ${get(r, "docNo", "doc_no") ?? ""} ${get(r, "refNo", "ref_no") ?? ""} ${issueOf(r) ?? ""} ${get(r, "itemDescription", "item_description", "itemCode", "item_code") ?? ""}`.toLowerCase();
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
  }, [all, q, chip, sort, user?.id]);

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* header (.hdr) — eyebrow + title + new-case iconbtn */}
      <header className="hdr">
        <div className="hdr-row">
          <div>
            {onBack ? (
              <button className="back" onClick={onBack} style={{ marginBottom: 4 }}>
                <span className="chev">‹</span> Menu
              </button>
            ) : null}
            <div className="eyebrow">After-sales</div>
            <div className="scr-title">Service Cases</div>
          </div>
          <button onClick={onNew} className="iconbtn" aria-label="New service case">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={TEAL} strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={GREY} strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search case · SO · Ref · customer" />
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as "sla" | "no")} style={{ flex: "none", fontFamily: "inherit", fontSize: 12, color: "var(--mut)", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "0 8px", height: 38, appearance: "none", WebkitAppearance: "none" }}>
            <option value="sla">Sort: SLA</option>
            <option value="no">Sort: Case</option>
          </select>
        </div>
        {/* status chips — petrol active pill with count badge (design SegChips) */}
        <div className="hz-scroll" style={{ display: "flex", gap: 8, overflowX: "auto", marginTop: 11, paddingBottom: 2 }}>
          {CHIPS.map((c) => {
            const on = chip === c.key;
            return (
              <button
                key={c.key}
                onClick={() => setChip(c.key)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, flex: "none",
                  padding: "7px 13px", borderRadius: 999, cursor: "pointer",
                  border: `1px solid ${on ? TEAL : LINE_SOFT}`,
                  background: on ? TEAL : "#fff", color: on ? "#fff" : INK_SEC,
                  fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
                }}
              >
                {c.label}
                <span style={{ fontSize: 11, fontWeight: 700, padding: "0 6px", borderRadius: 999, background: on ? "rgba(255,255,255,0.22)" : FIELD_BG, color: on ? "#fff" : MUTED }}>
                  {counts[c.key] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {isLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load service cases. Pull to retry.</div>}
        {!isLoading && !error && (
          <>
            {rows.length > 0 && (
              <MobileVirtualList
                items={rows}
                getKey={(r) => Number(get(r, "id"))}
                estimateHeight={132}
                renderItem={(r) => {
              const id = Number(get(r, "id"));
              const cancelled = statusOf(r).toLowerCase() === "cancelled";
              const pr = PRIORITY_META[priorityOf(r)] ?? PRIORITY_META.normal;
              const sla = slaStateOf(r);
              const tone = SLA_TONE[sla.tone];
              const item = get(r, "itemDescription", "item_description", "itemCode", "item_code");
              const idx = STAGE_INDEX[stageOf(r)] ?? -1;
              return (
                <div
                  key={id}
                  onClick={() => onOpen(id)}
                  style={{
                    background: "#fff", borderRadius: 16, border: `1px solid ${LINE_SOFT}`,
                    overflow: "hidden", cursor: "pointer", position: "relative",
                    boxShadow: "0 1px 2px rgba(17,20,15,0.03)", opacity: cancelled ? 0.55 : 1,
                  }}
                >
                  {/* priority stripe */}
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: pr.color }} />
                  <div style={{ padding: "13px 15px 13px 17px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span className="money" style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>{String(caseNo(r))}</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: pr.color, flex: "none" }} />
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: pr.color }}>{pr.label}</span>
                      </span>
                      <div style={{ flex: 1 }} />
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 999, background: tone.bg, color: tone.fg, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {sla.label}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
                      <Avatar name={String(customer(r))} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{customer(r)}</div>
                        <div style={{ fontSize: 12.5, color: INK_SEC, marginTop: 1, ...cellEllipsis }}>{item ? String(item) : "—"}</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: TEAL_DK }}>{prettyStage(stageOf(r))}</span>
                        <span style={{ fontSize: 11, color: GREY }}>{Math.max(idx, 0) + 1}/{STAGES.length}</span>
                      </div>
                      {/* mini 8-step progress bars */}
                      <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                        {STAGES.map((s, i) => {
                          const done = idx >= 0 && i < idx;
                          const cur = i === idx;
                          return (
                            <div key={s.key} style={{ flex: 1, height: cur ? 5 : 4, borderRadius: 999, background: done || cur ? TEAL : DIM, opacity: done ? 0.55 : 1 }} />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
                }}
              />
            )}
            {!rows.length && (
              <div className="empty">
                <div className="empty-t">Nothing matches</div>
                <div className="empty-s">Try a different filter or search.</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// initials avatar (design SC_Avatar) — hue derived from the name.
function Avatar({ name, size = 38 }: { name: string; size?: number }) {
  const init = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "—";
  const hue = [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flex: "none",
      background: `oklch(0.62 0.09 ${hue})`, color: "#fff",
      display: "grid", placeItems: "center", fontSize: size * 0.36, fontWeight: 600, letterSpacing: 0.2,
    }}>{init}</div>
  );
}

// ── DETAIL — tabbed (Overview / Stage / Info / Timeline) ──────────
type DetailTab = "overview" | "stage" | "info" | "timeline";

function CaseDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const choose = useChoice();
  const [tab, setTab] = useState<DetailTab>("overview");
  const [openStage, setOpenStage] = useState<string | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
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
  const stageHistory: Any[] = data?.stage_history ?? data?.stageHistory ?? [];
  const portalToken = get(data ?? {}, "portal_token", "portalToken");

  const sla = slaText(hoursToDeadline(c));
  const leadDays = get(c, "stageTargetDays", "stage_target_days");
  const resolutionMethod = get(c, "resolutionMethod", "resolution_method");
  const curStageIdx = STAGE_INDEX[stageOf(c)] ?? -1;
  const nextStage = curStageIdx >= 0 ? STAGES[curStageIdx + 1] : undefined;
  const isCompleted = stageOf(c) === "completed";

  // Latest history row per stage (drives done-times in the Info accordion).
  const historyByStage = useMemo(() => {
    const m: Record<string, Any> = {};
    for (const h of stageHistory) m[String(get(h, "stage") ?? "")] = h;
    return m;
  }, [stageHistory]);

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
  const assignedTo2 = get(c, "assignedTo2Name", "assigned_to_2_name");

  // ── Add-item picker source — the case's SO line items (desktop parity) ──
  // Mirrors desktop openAddItem(): GET /api/assr/lookup-items/:doc_no returns
  // { items: [{ item_code, item_description, qty? }] }. We only offer items
  // that aren't already on the case; when nothing is pickable the "+ Add item"
  // action is hidden entirely (see the Product info section below).
  type LookupItem = { item_code: string; item_description: string | null; qty?: number };
  const caseDocNo = String(get(c, "docNo", "doc_no") ?? "").trim();
  const { data: lookupData } = useQuery({
    queryKey: ["mobile-assr-lookup-items", caseDocNo],
    enabled: !!caseDocNo,
    staleTime: 60_000,
    queryFn: () => api.get<{ items?: LookupItem[] }>(`/api/assr/lookup-items/${encodeURIComponent(caseDocNo)}`),
  });
  const availableItems: LookupItem[] = useMemo(() => {
    const existing = new Set(items.map((it) => String(get(it, "itemCode", "item_code") ?? "")));
    return (lookupData?.items ?? []).filter((it) => !existing.has(it.item_code));
  }, [lookupData, items]);

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
  // Desktop parity: pick from the case's SO line items (availableItems,
  // already filtered to what's not on the case yet) via the in-app single-
  // select ChoiceDialog. The "+ Add item" affordance is hidden when nothing
  // is available, so this only fires with a non-empty list. Qty carries the
  // SO qty (or 1), matching the endpoint's `qty ?? 1`. No naked window.prompt.
  const addItem = async () => {
    if (busy || !availableItems.length) return;
    const picked = await choose({
      title: "Add product item",
      body: `From SO ${caseDocNo || "—"}`,
      options: availableItems.map((it) => ({
        value: it.item_code,
        label: it.item_code,
        detail: it.item_description || undefined,
      })),
    });
    if (picked == null) return;
    const chosen = availableItems.find((it) => it.item_code === picked);
    if (!chosen) return;
    await runWrite(async () => {
      await api.post(`/api/assr/${id}/items`, {
        items: [{
          item_code: chosen.item_code,
          item_description: chosen.item_description,
          qty: chosen.qty && chosen.qty > 0 ? chosen.qty : 1,
        }],
      });
    }, "Couldn't add item");
  };

  // ── Remove product item → DELETE /:id/items/:itemId (desktop parity) ──
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

  // ── Assign PIC → PATCH /:id { assigned_to } (desktop parity) ─────
  // The picker is narrowed to Operations-department members, keeping the
  // current assignee selectable, exactly as the desktop PIC select does.
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

  // Co-assignee — same picker, writes assigned_to_2 (desktop parity).
  const assignCoPic = async () => {
    if (busy) return;
    const curId = Number(get(c, "assignedTo2", "assigned_to_2") ?? 0) || null;
    const ops = assignableUsers.filter(
      (u) => /operation/i.test(u.department_name || "") || u.id === curId,
    );
    if (!ops.length) {
      await notify({ title: "No assignable users", body: "No Operations members are available to assign." });
      return;
    }
    const picked = await choose({
      title: "Co-assignee",
      body: assignedTo2 ? `Currently ${String(assignedTo2)}.` : "Currently none.",
      options: [
        { value: "", label: "— None —" },
        ...ops.map((u) => ({ value: String(u.id), label: u.name })),
      ],
    });
    if (picked == null) return;
    const nextId = picked === "" ? null : Number(picked);
    if (nextId === curId) return;
    await patchCase({ assigned_to_2: nextId }, "Couldn't set co-assignee");
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

  // Stage transition (used by the Stage tab select + the Advance sheet).
  const transitionTo = async (target: string, withConfirm = true) => {
    if (!target || target === stageOf(c)) return;
    if (withConfirm) {
      const label = STAGES[STAGE_INDEX[target]]?.long ?? target;
      if (!(await confirm({ title: `Move to ${label}?`, confirmLabel: "Change stage" }))) return;
    }
    await runWrite(async () => {
      await api.post(`/api/assr/${id}/transition`, { stage: target });
    }, "Stage change failed");
  };

  // Stage-chip tap (Stage tab) → jump to Info with that stage expanded.
  const jumpToStage = (key: string) => {
    setOpenStage(key);
    setTab("info");
  };

  const openStageEffective = openStage ?? (curStageIdx >= 0 ? STAGES[curStageIdx].key : null);

  const TABS: { k: DetailTab; label: string }[] = [
    { k: "overview", label: "Overview" },
    { k: "stage", label: "Stage" },
    { k: "info", label: "Info" },
    { k: "timeline", label: "Timeline" },
  ];

  // ── Per-stage Info panels (handoff STAGE_FIELDS map) ─────────────
  function stagePanel(key: string, state: "done" | "current" | "future") {
    const dis = busy || isArchived;
    switch (key) {
      case "pending_review":
        return (
          <>
            <KV label="Complaint" value={issueOf(c) ? String(issueOf(c)) : "—"} multiline />
            <KV label="Issue category" value={String(get(c, "issueCategory", "issue_category") ?? "—")} />
            <KV label="Complained date" value={dm(get(c, "complainedDate", "complained_date"))} />
            <div style={{ fontSize: 10.5, color: GREY, marginTop: 6 }}>Edit the complaint under Overview → Issue.</div>
          </>
        );
      case "under_verification":
        return (
          <>
            <div className="fld-l">Outcome</div>
            <div style={{ display: "flex", gap: 7, margin: "6px 0 10px", flexWrap: "wrap" }}>
              {VERIFICATION_OPTIONS.map((o) => {
                const active = String(get(c, "verificationOutcome", "verification_outcome") ?? "") === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => { if (!dis && !active) patchCase({ verification_outcome: o.value }, "Couldn't save verification"); }}
                    disabled={dis}
                    className="tinybtn"
                    style={active ? { background: TEAL, borderColor: TEAL, color: "#fff" } : undefined}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <RootCauseField
              value={get(c, "verifiedRootCause", "verified_root_cause")}
              busy={busy}
              onSave={(v) => patchCase({ verified_root_cause: v || null }, "Couldn't save verification")}
            />
            {/* QC issue inspection — on receipt (mig 0105: folded in from the
                retired Pending Inspection stage). */}
            <div className="fld-l" style={{ marginTop: 10 }}>QC issue inspection result</div>
            <div style={{ display: "flex", gap: 7, margin: "6px 0 4px" }}>
              {QC_RESULT_OPTIONS.map((o) => {
                const active = String(get(c, "qcIssueResult", "qc_issue_result") ?? "") === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => { if (!dis) patchCase({ qc_issue_result: active ? null : o.value }, "Couldn't save QC issue result"); }}
                    disabled={dis}
                    className="tinybtn"
                    style={active ? { background: BROWN, borderColor: BROWN, color: "#fff" } : undefined}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <EditRow label="QC issue date" type="date" value={get(c, "qcReceiptDate", "qc_receipt_date")} busy={busy} disabled={dis} onSave={(v) => patchCase({ qc_receipt_date: v }, "Couldn't save QC issue date")} />
            {/* Inspect by — own team or supplier (inspection_by, mig 0073). */}
            <div className="fld-l" style={{ marginTop: 10, marginBottom: 8 }}>Inspect by</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
              {([{ v: "own", label: "Own team" }, { v: "supplier", label: "Supplier" }] as const).map((o) => {
                const on = String(get(c, "inspectionBy", "inspection_by") ?? "") === o.v;
                return (
                  <button
                    key={o.v}
                    onClick={() => { if (!dis) patchCase({ inspection_by: on ? null : o.v }, "Couldn't save inspect-by"); }}
                    disabled={dis}
                    style={{
                      flex: 1, height: 40, borderRadius: 10, cursor: dis ? "default" : "pointer", fontFamily: "inherit",
                      fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                      border: `1px solid ${on ? BROWN : LINE}`, background: on ? BROWN_SOFT : "#fff", color: on ? BROWN_FG : INK_SEC,
                      opacity: dis ? 0.6 : 1,
                    }}
                  >
                    {on && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={BROWN_FG} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
                    )}
                    {o.label}
                  </button>
                );
              })}
            </div>
            {/* QC issue photos — on-receipt evidence, same category as the
                desktop Verification card (receipt_evidence). */}
            <PhotoGrid
              caseId={id}
              attachments={attachments.filter((a) => String(get(a, "category") ?? "") === "receipt_evidence")}
              category="receipt_evidence"
              label="QC issue photos"
              hint="Tap to capture or upload · on receipt"
              accent={BROWN}
              onChanged={refetch}
              notify={notify}
              confirm={confirm}
            />
            {get(c, "verifiedByName", "verified_by_name") && (
              <div style={{ fontSize: 10.5, color: MUTED, background: FIELD_BG, borderRadius: 9, padding: "8px 10px", marginTop: 10 }}>
                Verified by {String(get(c, "verifiedByName", "verified_by_name"))} · {dm(get(c, "verifiedAt", "verified_at"))}
              </div>
            )}
          </>
        );
      case "pending_solution":
        return (
          <>
            <EditRow
              label="Resolution method"
              type="select"
              value={resolutionMethod}
              options={[{ value: "", label: "—" }, ...resolutionOptions.map((o) => ({ value: o, label: resolutionLabel(o) }))]}
              busy={busy}
              disabled={dis}
              onSave={(v) => patchCase({ resolution_method: v }, "Couldn't save resolution")}
            />
            <div className="fld-l" style={{ marginTop: 8 }}>Supplier</div>
            {creditorCode ? (
              <div style={{ display: "flex", alignItems: "center", gap: 9, border: `1px solid ${DIM}`, borderRadius: 10, padding: "10px 11px", marginTop: 5 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{String(get(c, "creditorName", "creditor_name") ?? creditorCode)}</div>
                  <div className="money" style={{ fontSize: 10, color: GREY }}>{String(creditorCode)}</div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: GREY, marginTop: 5 }}>No supplier linked.</div>
            )}
          </>
        );
      case "pending_item_pickup":
        return (
          <EditRow label="Customer pickup date" type="date" value={get(c, "customerPickupAt", "customer_pickup_at")} busy={busy} disabled={dis} onSave={(v) => patchCase({ customer_pickup_at: v }, "Couldn't save pickup date")} />
        );
      case "pending_supplier_pickup":
        return (
          <>
            <KV label="Supplier" value={String(get(c, "creditorName", "creditor_name") ?? creditorCode ?? "—")} />
            <KV label="Supplier code" value={creditorCode ? String(creditorCode) : "—"} mono />
            <EditRow label="Supplier pickup date" type="date" value={get(c, "supplierPickupAt", "supplier_pickup_at")} busy={busy} disabled={dis} onSave={(v) => patchCase({ supplier_pickup_at: v }, "Couldn't save pickup date")} />
            <EditRow label="Supplier status update" type="textarea" value={get(c, "actionRemark", "action_remark")} busy={busy} disabled={dis} onSave={(v) => patchCase({ action_remark: v }, "Couldn't save status update")} />
          </>
        );
      case "pending_item_ready":
        return (
          <>
            <div className="fld-l">QC result (after repair)</div>
            <div style={{ display: "flex", gap: 7, margin: "6px 0 4px" }}>
              {QC_RESULT_OPTIONS.map((o) => {
                const active = String(get(c, "inspectionResult", "inspection_result") ?? "") === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => { if (!dis) patchCase({ inspection_result: active ? null : o.value }, "Couldn't save QC result"); }}
                    disabled={dis}
                    className="tinybtn"
                    style={active ? { background: GREEN, borderColor: GREEN, color: "#fff" } : undefined}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <EditRow label="QC inspection date" type="date" value={get(c, "itemsReadyAt", "items_ready_at")} busy={busy} disabled={dis} onSave={(v) => patchCase({ items_ready_at: v }, "Couldn't save QC date")} />
            <div style={{ fontSize: 10, color: GREY, marginTop: 2 }}>Pass + date → becomes the Item Ready date. Fail → stays pending.</div>
            {/* After-repair QC photos / report — same category the old
                "Upload inspection report" button used (qc). */}
            <PhotoGrid
              caseId={id}
              attachments={attachments.filter((a) => ["qc", "inspection_report"].includes(String(get(a, "category") ?? "")))}
              category="qc"
              label="QC photos"
              hint="After-repair QC evidence / report"
              accent={GREEN}
              onChanged={refetch}
              notify={notify}
              confirm={confirm}
            />
          </>
        );
      case "pending_delivery_service":
        return (
          <>
            <EditRow label="Delivery order" value={get(c, "deliveryOrder", "delivery_order")} mono busy={busy} disabled={dis} onSave={(v) => patchCase({ delivery_order: v }, "Couldn't save delivery order")} />
            <EditRow label="DO date" type="date" value={get(c, "doDate", "do_date")} busy={busy} disabled={dis} onSave={(v) => patchCase({ do_date: v }, "Couldn't save DO date")} />
            <EditRow label="Ref No" value={get(c, "refNo", "ref_no")} mono busy={busy} disabled={dis} onSave={(v) => patchCase({ ref_no: v }, "Couldn't save Ref No")} />
          </>
        );
      case "completed":
        return (
          <>
            <KV label="Status" value={statusOf(c) ? cap(statusOf(c).replace(/_/g, " ")) : "—"} />
            <KV label="Completed" value={dm(get(c, "completionDate", "completion_date", "closedAt", "closed_at"))} />
            {state !== "current" && state !== "done" && (
              <div style={{ fontSize: 10.5, color: GREY, marginTop: 6 }}>Sign-off lands here when the case closes.</div>
            )}
          </>
        );
      default:
        return <div style={{ fontSize: 12, color: GREY, padding: "6px 0" }}>No fields for this stage.</div>;
    }
  }

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)", position: "relative" }}>
      {/* header (.hdr) — back + Archive · stage badge · case no + priority · customer · tabs */}
      <header className="hdr" style={{ paddingBottom: 0 }}>
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Cases
          </button>
          {!isLoading && !error && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flex: "none" }}>
              {isArchived ? (
                <span className="badge b-grey">Archived</span>
              ) : (
                <button onClick={archiveCase} disabled={busy} className="tinybtn" style={{ opacity: busy ? 0.5 : 1 }}>Archive</button>
              )}
              <span style={{ padding: "3px 10px", borderRadius: 999, background: BROWN_SOFT, color: BROWN_FG, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                {prettyStage(stageOf(c))}
              </span>
            </span>
          )}
        </div>
        <div className="money" style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginTop: 8 }}>
          {String(caseNo(c))} · {(PRIORITY_META[priorityOf(c)] ?? PRIORITY_META.normal).label}
        </div>
        <div className="scr-title" style={{ marginTop: 2 }}>{customer(c)}</div>
        {assignedTo ? (
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
            Assigned {[assignedTo, assignedTo2].filter(Boolean).map(String).join(" · ")}
          </div>
        ) : null}
        {/* tab row */}
        <div style={{ display: "flex", gap: 2, marginTop: 8 }}>
          {TABS.map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              style={{
                flex: 1, padding: "10px 2px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
                borderBottom: tab === t.k ? `2.5px solid ${TEAL}` : "2.5px solid transparent",
                fontSize: 12.5, fontWeight: tab === t.k ? 700 : 600, color: tab === t.k ? TEAL : MUTED,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 170 }}>
        {isLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load this case.</div>}
        {!isLoading && !error && (
          <>
            {/* ══ OVERVIEW ══ */}
            {tab === "overview" && (
              <>
                {/* SLA banner */}
                <div style={{ background: sla?.overdue ? ERR_BG : "#fff", border: `1px solid ${sla?.overdue ? "rgba(178,58,58,0.25)" : LINE_SOFT}`, borderRadius: 13, padding: "12px 14px", marginBottom: 10 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: sla?.overdue ? RED : MUTED }}>SLA</div>
                  <div style={{ fontSize: 12, color: sla?.overdue ? "#7a2222" : INK_SEC, marginTop: 5 }}>
                    Deadline {dm(get(c, "deadlineAt", "deadline_at"))} · {(PRIORITY_META[priorityOf(c)] ?? PRIORITY_META.normal).label}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: sla?.overdue ? RED : isCompleted ? GREY : GREEN, marginTop: 2 }}>
                    {isCompleted ? "Closed" : sla ? sla.label : "No SLA deadline"}
                  </div>
                </div>

                {/* meta line — Priority / Lead time / Resolution */}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11, color: MUTED, marginBottom: 13 }}>
                  <span>Priority <b style={{ color: INK }}>{cap(priorityOf(c))}</b></span>
                  {leadDays != null && <span>Lead time <b style={{ color: INK }}>{Number(leadDays).toFixed(1)}d</b></span>}
                  {resolutionMethod && <span>Resolution <b style={{ color: INK }}>{resolutionLabel(String(resolutionMethod))}</b></span>}
                </div>

                {/* Issue (Edit → Save) — Complaint / Issue category / Priority,
                    with the defect photo grid inside (design keeps it here). */}
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
                  <PhotoGrid
                    caseId={id}
                    attachments={attachments.filter((a) => !["receipt_evidence", "qc", "inspection_report"].includes(String(get(a, "category") ?? "")))}
                    category="complaint"
                    label="Photos / videos"
                    onChanged={refetch}
                    notify={notify}
                    confirm={confirm}
                  />
                </EditableAcc>

                {/* Product info — items + "+ Add item" + Product category. */}
                <EditableAcc
                  title="Product info"
                  open
                  busy={busy}
                  fields={[
                    // Prototype's "Product category" field → the REAL, whitelisted
                    // assr_cases.service_category column (desktop ServiceCases.tsx
                    // edits this same key). There is NO product_category column
                    // server-side, so writing that key would silently no-op and
                    // never read back — we bind to service_category instead.
                    { key: "service_category", label: "Product category", value: get(c, "serviceCategory", "service_category"), type: "text" },
                  ]}
                  onSave={(body) => patchCase(body, "Couldn't save product info")}
                  headSlot={
                    availableItems.length ? (
                      <span
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) addItem(); }}
                        className="tinybtn"
                        style={{ color: BROWN, opacity: busy ? 0.5 : 1 }}
                      >
                        + Add item
                      </span>
                    ) : undefined
                  }
                >
                  {items.length ? items.map((it, i) => (
                    <div key={get(it, "id") ?? i} style={{ display: "flex", alignItems: "center", gap: 9, border: `1px solid ${DIM}`, borderRadius: 10, padding: "10px 11px", marginBottom: 7 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="money" style={{ fontSize: 10, fontWeight: 700, color: BROWN }}>{String(get(it, "itemCode", "item_code") ?? "—")}</div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: INK, marginTop: 2 }}>{String(get(it, "itemDescription", "item_description") ?? "—")}</div>
                      </div>
                      <span style={{ fontSize: 11, color: MUTED }}>×{String(get(it, "qty") ?? 1)}</span>
                      <button
                        onClick={() => removeItem(it)}
                        disabled={busy}
                        aria-label="Remove item"
                        style={{ flex: "none", width: 26, height: 26, borderRadius: 8, border: `1px solid ${DIM}`, background: "#fff", color: RED, fontSize: 15, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
                      >
                        ×
                      </button>
                    </div>
                  )) : (
                    <div style={{ fontSize: 12, color: GREY, padding: "2px 0" }}>No items recorded.</div>
                  )}
                  <KV label="PO No" value={(poNo ? [String(poNo)] : []).concat(relatedPOs.map((p) => String(get(p, "docNo", "doc_no") ?? "")).filter(Boolean)).join(", ") || "—"} mono />
                </EditableAcc>
              </>
            )}

            {/* ══ STAGE — grouped phases (Intake / Repair / Return) ══ */}
            {tab === "stage" && (
              <div style={{ background: "#fff", borderRadius: 14, border: `1px solid ${LINE_SOFT}`, padding: 14 }}>
                <div className="fld-l">Stage</div>
                <div style={{ marginTop: 12 }}>
                  {/* progress bar + n/8 */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                    <div style={{ flex: 1, height: 6, borderRadius: 999, background: DIM, overflow: "hidden" }}>
                      <div style={{ width: `${Math.round((Math.max(curStageIdx, 0) / (STAGES.length - 1)) * 100)}%`, height: "100%", background: `linear-gradient(90deg, ${GREEN}, ${BROWN})`, borderRadius: 999 }} />
                    </div>
                    <span className="money" style={{ fontSize: 11.5, fontWeight: 700, color: INK_SEC }}>{Math.max(curStageIdx, 0) + 1}/{STAGES.length}</span>
                  </div>
                  {PHASES.map((p) => {
                    const allDone = p.idx.every((i) => i < curStageIdx);
                    const active = p.idx.some((i) => i === curStageIdx);
                    const d = p.idx.filter((i) => i < curStageIdx).length;
                    return (
                      <div key={p.name} style={{
                        border: `1px solid ${active ? BROWN : allDone ? "transparent" : LINE_SOFT}`,
                        background: allDone ? OK_BG : active ? BROWN_SOFT : "#fff",
                        borderRadius: 11, padding: "11px 12px", marginBottom: 8,
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <span style={{ width: 9, height: 9, borderRadius: "50%", flex: "none", background: allDone ? GREEN : active ? BROWN : DIM }} />
                          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: allDone ? GREEN : active ? BROWN_FG : INK }}>{p.name}</span>
                          <span className="money" style={{ fontSize: 10.5, color: MUTED }}>{allDone ? "Done" : `${d}/${p.idx.length}`}</span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
                          {p.idx.map((i) => {
                            const on = i < curStageIdx;
                            const isc = i === curStageIdx;
                            return (
                              <button
                                key={STAGES[i].key}
                                onClick={() => jumpToStage(STAGES[i].key)}
                                style={{
                                  fontSize: 10, fontWeight: 600, padding: "4px 9px", borderRadius: 999, fontFamily: "inherit",
                                  border: "none", cursor: "pointer",
                                  background: on ? "rgba(47,138,91,0.14)" : isc ? BROWN : FIELD_BG,
                                  color: on ? GREEN : isc ? "#fff" : GREY,
                                }}
                              >
                                {STAGES[i].label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 11, color: GREY, marginTop: 10, textAlign: "center" }}>Tap a stage to see its details</div>

                  {/* Change to — arbitrary (incl. backward) transition, kept
                      from the previous design so ops can correct mistakes. */}
                  <label className="fld" style={{ marginTop: 12, marginBottom: 0 }}>
                    <span className="fld-l">Change stage to</span>
                    <select
                      value={stageOf(c)}
                      disabled={busy || isArchived}
                      onChange={(e) => transitionTo(e.target.value)}
                      className="fld-i"
                    >
                      {STAGES.map((s) => (
                        <option key={s.key} value={s.key}>{s.long}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            )}

            {/* ══ INFO — per-stage accordion + case details ══ */}
            {tab === "info" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: MUTED, margin: "2px 2px 10px" }}>Stage details</div>
                {STAGES.map((s, si) => {
                  const st: "done" | "current" | "future" = si < curStageIdx ? "done" : si === curStageIdx ? "current" : "future";
                  const h = historyByStage[s.key];
                  const open = openStageEffective === s.key;
                  const dot = st === "done" ? GREEN : st === "current" ? BROWN : DIM;
                  return (
                    <div key={s.key} style={{ background: "#fff", borderRadius: 12, border: `1px solid ${open ? (st === "current" ? BROWN : "rgba(34,31,32,0.20)") : LINE_SOFT}`, marginBottom: 8, overflow: "hidden" }}>
                      <button
                        onClick={() => setOpenStage(open ? "" : s.key)}
                        style={{
                          width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "12px 13px",
                          background: open && st === "current" ? BROWN_SOFT : "transparent", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                        }}
                      >
                        <span style={{ width: 20, height: 20, borderRadius: "50%", flex: "none", background: st === "future" ? "#fff" : dot, border: st === "future" ? `2px solid ${DIM}` : "none", display: "grid", placeItems: "center" }}>
                          {st === "done" && (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
                          )}
                          {st === "current" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
                        </span>
                        <span style={{ flex: 1, fontSize: 13, fontWeight: st === "future" ? 600 : 700, color: st === "future" ? GREY : INK }}>{s.long}</span>
                        {st === "done" && (
                          <span style={{ fontSize: 10.5, color: GREEN, fontWeight: 600 }}>{h?.skipped ? "Skipped" : dm(get(h ?? {}, "exitedAt", "exited_at", "enteredAt", "entered_at"))}</span>
                        )}
                        {st === "current" && <span style={{ fontSize: 9.5, fontWeight: 700, color: "#fff", background: BROWN, padding: "2px 7px", borderRadius: 999 }}>CURRENT</span>}
                        {st === "future" && <span style={{ fontSize: 10.5, color: GREY }}>Not started</span>}
                        <span style={{ color: "#c2c6bd", fontSize: 15, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
                      </button>
                      {open && (
                        <div style={{ padding: "0 13px 12px" }}>
                          <div style={{ fontSize: 11, color: GREY, padding: "0 0 6px" }}>
                            Owner: {s.owner}
                            {h ? ` · ${dm(get(h, "enteredAt", "entered_at"))}` : ""}
                          </div>
                          {stagePanel(s.key, st)}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: MUTED, margin: "16px 2px 10px" }}>Case details</div>

                {/* Customer (Edit → Save + read-only .pgrid2 references). */}
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
                    <PGrid label="Ref No" value={String(get(c, "refNo", "ref_no") ?? "—")} mono />
                    <PGrid label="Date" value={dm(get(c, "complainedDate", "complained_date", "createdAt", "created_at"))} />
                    <PGrid
                      label="Address"
                      span
                      multiline
                      value={
                        [get(c, "addr1"), get(c, "addr2"), get(c, "addr3"), get(c, "addr4")]
                          .filter(Boolean)
                          .join(", ") || "—"
                      }
                    />
                  </div>
                </EditableAcc>

                {/* PIC — right-header = current assignee; Assign reassigns via PATCH */}
                <Acc
                  title="PIC"
                  open
                  headRight={[assignedTo, assignedTo2].filter(Boolean).map(String).join(" · ") || "Unassigned"}
                  headSlot={
                    <>
                      <span
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) assignPic(); }}
                        className="tinybtn"
                        style={{ color: BROWN, opacity: busy ? 0.5 : 1 }}
                      >
                        Assign
                      </span>
                      <span
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) assignCoPic(); }}
                        className="tinybtn"
                        style={{ color: BROWN, opacity: busy ? 0.5 : 1, marginLeft: 6 }}
                      >
                        Co-assign
                      </span>
                    </>
                  }
                >
                  <KV label="Assigned to" value={assignedTo ? String(assignedTo) : "Unassigned"} />
                  <KV label="Co-assignee" value={assignedTo2 ? String(assignedTo2) : "None"} />
                  <KV label="Created by" value={String(get(c, "createdByName", "created_by_name") ?? "—")} />
                </Acc>

                {/* Print copy + Portal link + Sales link. Links carry the
                    ASSR slug for readability; tokens are permanent. */}
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button onClick={printCopy} className="tinybtn" style={{ flex: 1, padding: 9 }}>Print copy</button>
                  <button
                    onClick={async () => {
                      if (!portalToken) return;
                      const slug = String(caseNo(c)).replace(/[^A-Za-z0-9-]+/g, "-");
                      const url = `${window.location.origin}/portal/case/${slug}/${portalToken}`;
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
                  <button
                    onClick={async () => {
                      if (busy) return;
                      try {
                        const r = await api.post<{ token: string }>(`/api/assr/${id}/sales-link`);
                        const slug = String(caseNo(c)).replace(/[^A-Za-z0-9-]+/g, "-");
                        const url = `${window.location.origin}/portal/case/${slug}/${r.token}`;
                        if (navigator.clipboard) await navigator.clipboard.writeText(url);
                        await notify({ title: "Sales link copied", body: url });
                      } catch (e: any) {
                        await notify({ title: "Sales link failed", body: e?.message || "Try again." });
                      }
                    }}
                    className="tinybtn"
                    style={{ flex: 1, padding: 9 }}
                  >
                    Sales link
                  </button>
                </div>
              </>
            )}

            {/* ══ TIMELINE ══ */}
            {tab === "timeline" && (
              <Acc
                title="Timeline"
                open
                headSlot={
                  <span
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); const el = document.getElementById(`svc-note-${id}`); el?.focus(); }}
                    className="tinybtn"
                    style={{ background: BROWN, borderColor: BROWN, color: "#fff" }}
                  >
                    + Add note
                  </span>
                }
              >
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
                    id={`svc-note-${id}`}
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
            )}
          </>
        )}
      </div>

      {/* floating action bar — Note + Advance / Mark complete / Print.
          Floats above the app's bottom tab bar (navwrap, z30) which sits
          ~74px + safe-area tall; the sheets below use fixed z40 instead. */}
      {!isLoading && !error && (
        <div style={{
          position: "absolute", left: 12, right: 12, bottom: "calc(env(safe-area-inset-bottom) + 86px)", zIndex: 20,
          display: "flex", gap: 9, alignItems: "stretch",
          background: "rgba(255,255,255,0.94)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
          border: `1px solid ${LINE}`, borderRadius: 16, padding: 9,
          boxShadow: "0 14px 34px -14px rgba(17,24,16,0.4)",
        }}>
          <button
            onClick={() => setNoteOpen(true)}
            className="tinybtn"
            style={{ flex: "none", padding: "0 18px", height: 42, fontSize: 13 }}
          >
            Note
          </button>
          {isCompleted ? (
            <button onClick={printCopy} className="tinybtn" style={{ flex: 1, height: 42, fontSize: 13.5, fontWeight: 700 }}>
              Print
            </button>
          ) : (
            <button
              onClick={() => setAdvOpen(true)}
              disabled={busy || isArchived || !nextStage}
              style={{
                flex: 1, height: 42, borderRadius: 11, border: "none", background: TEAL, color: "#fff",
                fontFamily: "inherit", fontWeight: 700, fontSize: 14, cursor: "pointer",
                opacity: busy || isArchived || !nextStage ? 0.55 : 1,
              }}
            >
              {nextStage?.key === "completed" ? "Mark complete" : "Advance stage →"}
            </button>
          )}
        </div>
      )}

      {/* Advance sheet — current → next chips + confirm. */}
      {advOpen && nextStage && (
        <SheetShell title="Advance stage" onClose={() => setAdvOpen(false)}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0 14px", flexWrap: "wrap" }}>
            <span style={{ padding: "7px 13px", borderRadius: 10, fontSize: 13, fontWeight: 700, background: FIELD_BG, color: INK_SEC }}>{prettyStage(stageOf(c))}</span>
            <span style={{ color: GREY, fontSize: 15 }}>›</span>
            <span style={{ padding: "7px 13px", borderRadius: 10, fontSize: 13, fontWeight: 700, background: TEAL, color: "#fff" }}>{nextStage.long}</span>
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 16 }}>
            Next-stage owner: <b style={{ color: INK_SEC }}>{nextStage.owner}</b>. The customer portal reflects the change immediately.
          </div>
          <button
            className="btn"
            disabled={busy}
            style={{ opacity: busy ? 0.6 : 1 }}
            onClick={async () => {
              setAdvOpen(false);
              await transitionTo(nextStage.key, false);
            }}
          >
            {nextStage.key === "completed" ? "Confirm — mark complete" : "Confirm advance"}
          </button>
        </SheetShell>
      )}

      {/* Note sheet — audience + textarea, posts to /:id/notes. */}
      {noteOpen && (
        <NoteSheet
          onClose={() => setNoteOpen(false)}
          saving={addNote.isPending}
          onSave={(text, audience) => {
            addNote.mutate({ note: text, category: audience });
            setNoteOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ── bottom sheet shell (fixed z40 — same pattern as NewCaseSheet, which
// must sit ABOVE the floating tab bar at z30) ───────────────────────
function SheetShell({ title, onClose, children }: { title?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(17,20,15,.4)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: "10px 18px", paddingBottom: "calc(env(safe-area-inset-bottom) + 24px)", maxHeight: "80%", overflowY: "auto" }}>
        <div style={{ width: 38, height: 4, borderRadius: 999, background: DIM, margin: "4px auto 14px" }} />
        {title && <div style={{ fontSize: 17, fontWeight: 700, color: INK, marginBottom: 14 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

// Note entry sheet — own local draft (the Timeline tab keeps its inline
// input too; both post through the same mutation).
function NoteSheet({ onClose, onSave, saving }: {
  onClose: () => void;
  onSave: (note: string, audience: "purchasing" | "customer") => void;
  saving: boolean;
}) {
  const [text, setText] = useState("");
  const [audience, setAudience] = useState<"purchasing" | "customer">("purchasing");
  return (
    <SheetShell title="Add note" onClose={onClose}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {NOTE_AUDIENCE_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => setAudience(o.value)}
            className={`sochip${audience === o.value ? " on" : ""}`}
            style={{ flex: 1 }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Findings, next steps…"
        className="fld-i"
        style={{ resize: "none", width: "100%", boxSizing: "border-box" }}
      />
      <div style={{ fontSize: 10, color: GREY, margin: "6px 0 12px" }}>
        {audience === "customer" ? "Visible to the customer on the portal." : "Internal only — hidden from the customer."}
      </div>
      <button
        className="btn"
        disabled={!text.trim() || saving}
        style={{ opacity: !text.trim() || saving ? 0.6 : 1 }}
        onClick={() => text.trim() && onSave(text.trim(), audience)}
      >
        {saving ? "Saving…" : "Save note"}
      </button>
    </SheetShell>
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
  // Affected products — MULTISELECT with per-product qty (owner 2026-07:
  // sometimes 1 product, sometimes several). The backend create endpoint
  // already accepts an `items` array of { item_code, item_description, qty }
  // (assr_items rows, same as desktop CreatePanel) — no schema change.
  type SelItem = { item_code: string; item_description: string | null; qty: number };
  const [selItems, setSelItems] = useState<SelItem[]>([]);
  // Free-text adder draft (used when the SO has no lookup items).
  const [manualCode, setManualCode] = useState("");
  const [complaint, setComplaint] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("normal");
  // Optional "Issue number" (handoff §5) — the customer's own complaint /
  // ticket ref. Maps to assr_cases.ref_no; when left blank the create
  // endpoint falls back to the SO's pre-printed Ref (input.ref_no ?? ctx.Ref).
  const [issueNo, setIssueNo] = useState("");
  // Complaint date (assr_cases.complained_date) — defaults to today (MYT).
  // Stored/sent as YYYY-MM-DD (the native date input's value format, which
  // is also what the backend's todayMyt() default produces).
  const [complainedDate, setComplainedDate] = useState<string>(() => todayMyt());
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
    // Different SO → its items no longer apply; start the pick list fresh.
    setSelItems([]);
    setManualCode("");
  };
  const clearSo = () => { setSoPicked(null); setDocNo(""); setSoQuery(""); setSelItems([]); setManualCode(""); };

  // ── multi-item helpers ──
  const addSelItem = (item: SelItem) => {
    setSelItems((prev) =>
      prev.some((it) => it.item_code === item.item_code) ? prev : [...prev, item],
    );
  };
  const removeSelItem = (code: string) =>
    setSelItems((prev) => prev.filter((it) => it.item_code !== code));
  const setSelQty = (code: string, qty: number) =>
    setSelItems((prev) => prev.map((it) => (it.item_code === code ? { ...it, qty: Math.max(1, qty) } : it)));
  // SO items not yet on the pick list (dropdown adder source).
  const remainingSoItems = soItems.filter(
    (it) => !selItems.some((s) => s.item_code === String(get(it, "itemCode", "item_code") ?? "")),
  );
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
        // Multi-item: every picked row lands as its own assr_items row with
        // its chosen qty — identical shape to desktop CreatePanel's submit.
        items: selItems.map((it) => ({
          item_code: it.item_code,
          item_description: it.item_description,
          qty: it.qty > 0 ? it.qty : 1,
        })),
        complaint_issue: complaint.trim(),
        issue_category: category.trim() || null,
        priority,
        // Empty string must NOT reach the server — it would beat the
        // `?? context.Ref` SO-reference fallback.
        ref_no: issueNo.trim() || null,
        // Complaint date — the backend defaults this to today (MYT) when
        // omitted; we always send the (defaulted-to-today, user-editable)
        // value so the intake date is honoured. Sent as YYYY-MM-DD.
        complained_date: complainedDate || null,
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
      // Refresh the cases list so the just-created case shows immediately.
      // `refetchType: "all"` forces even the (about-to-unmount) list query
      // to refetch, so a fresh row is present whether the user lands on the
      // detail page and taps back, or returns to the list directly.
      qc.invalidateQueries({ queryKey: ["mobile-assr-list"], refetchType: "all" });
      const id = Number(get(res ?? {}, "id"));
      onClose();
      if (id) onOpen(id);
    },
  });

  const valid = docNo.trim() && selItems.length > 0 && complaint.trim() && complainedDate.trim();

  // FIXED + z-index 40 (the .sheet-bd pattern) — NOT absolute/z20. When
  // Service is the active TAB this sheet renders inside the tab-content
  // div, and the floating tab bar (.navwrap, absolute bottom, z-index 30)
  // would otherwise sit ON TOP of the sheet's bottom actbar, hiding the
  // Create button entirely (owner: "no way to create"). Fixed + 40 lifts
  // the whole sheet above the tab bar, exactly like the Menu sheet.
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(17,20,15,.4)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--app-bg)", borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: "92%", display: "flex", flexDirection: "column", paddingBottom: "env(safe-area-inset-bottom)" }}>
        {/* header (.hdr) — design: eyebrow "Document" + title, top-right × close */}
        <header className="hdr" style={{ borderTopLeftRadius: 18, borderTopRightRadius: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div className="eyebrow">Document</div>
              <div className="scr-title" style={{ marginTop: 2 }}>New Service Case</div>
            </div>
            <span onClick={onClose} role="button" aria-label="Close" style={{ fontSize: 24, color: MUTED, cursor: "pointer", lineHeight: 1 }}>×</span>
          </div>
        </header>

        <div className="scroll hz-scroll" style={{ padding: 14 }}>
          {/* ── Sales Order card (.so-card) — SO lookup + affected product ── */}
          <div className="so-card">
            <div className="so-hd"><h2 className="so-ti">Sales Order</h2></div>
            <div className="so-bd">
              {/* SO picker — real search-so lookup, presented as the design's
                  "SO # / reference / customer" field + Lookup affordance. */}
              <div className="fld" style={{ position: "relative" }}>
                <span className="fld-l">SO # / reference / customer *</span>
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
                    <input value={soQuery} onChange={(e) => setSoQuery(e.target.value)} placeholder="SO #, reference, or customer name…" className="fld-i money" />
                    {soQuery.trim().length >= 2 && (
                      <div style={{ marginTop: 5, border: `1px solid ${DIM}`, borderRadius: 10, overflow: "hidden", maxHeight: 190, overflowY: "auto" }} className="hz-scroll">
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
              {/* Affected products — MULTISELECT rows with a per-product qty
                  stepper (owner: sometimes 1 product, sometimes several).
                  Backend requires at least one item; each row posts as its
                  own assr_items entry, same as desktop CreatePanel. */}
              <div className="fld">
                <span className="fld-l">Affected products * ({selItems.length})</span>
                {selItems.map((it) => (
                  <div key={it.item_code} style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${DIM}`, borderRadius: 10, padding: "8px 10px", marginBottom: 6, background: "#fff" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="money" style={{ fontSize: 11, fontWeight: 700, color: BROWN, wordBreak: "break-word" }}>{it.item_code}</div>
                      {it.item_description && <div style={{ fontSize: 11, color: MUTED, marginTop: 1, ...cellEllipsis }}>{it.item_description}</div>}
                    </div>
                    {/* qty stepper — min 1 */}
                    <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 0, border: `1px solid ${DIM}`, borderRadius: 8, overflow: "hidden" }}>
                      <button
                        onClick={() => setSelQty(it.item_code, it.qty - 1)}
                        disabled={it.qty <= 1}
                        aria-label="Decrease quantity"
                        style={{ width: 26, height: 28, border: "none", background: FIELD_BG, color: it.qty <= 1 ? GREY : INK, fontSize: 15, lineHeight: 1, cursor: it.qty <= 1 ? "default" : "pointer" }}
                      >
                        −
                      </button>
                      <span className="money" style={{ minWidth: 24, textAlign: "center", fontSize: 12, fontWeight: 700, color: INK }}>{it.qty}</span>
                      <button
                        onClick={() => setSelQty(it.item_code, it.qty + 1)}
                        aria-label="Increase quantity"
                        style={{ width: 26, height: 28, border: "none", background: FIELD_BG, color: INK, fontSize: 15, lineHeight: 1, cursor: "pointer" }}
                      >
                        +
                      </button>
                    </div>
                    <button
                      onClick={() => removeSelItem(it.item_code)}
                      aria-label="Remove product"
                      style={{ flex: "none", width: 26, height: 26, borderRadius: 8, border: `1px solid ${DIM}`, background: "#fff", color: RED, fontSize: 15, lineHeight: 1, cursor: "pointer" }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {/* Adder — SO line-item picker when the SO has items left to
                    add; a select that appends a row on choose. */}
                {remainingSoItems.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const code = e.target.value;
                      if (!code) return;
                      const hit = soItems.find((it) => String(get(it, "itemCode", "item_code") ?? "") === code);
                      const soQty = Number(get(hit ?? {}, "qty") ?? 0);
                      addSelItem({
                        item_code: code,
                        item_description: hit ? (get(hit, "itemDescription", "item_description") as string | undefined) ?? null : null,
                        qty: soQty > 0 ? soQty : 1,
                      });
                    }}
                    className="fld-i money"
                  >
                    <option value="">+ Add product from this SO…</option>
                    {remainingSoItems.map((it, i) => {
                      const code = String(get(it, "itemCode", "item_code") ?? "");
                      const desc = get(it, "itemDescription", "item_description");
                      return <option key={code + i} value={code}>{code}{desc ? ` — ${String(desc)}` : ""}</option>;
                    })}
                  </select>
                )}
                {/* Free-text adder — kept for SOs whose lookup returns no
                    items: type a code, tap Add (qty starts at 1). */}
                {!soItems.length && (
                  <div style={{ display: "flex", gap: 7 }}>
                    <input
                      value={manualCode}
                      onChange={(e) => setManualCode(e.target.value)}
                      placeholder="Affected item code — e.g. AK-GUARDIAN MATT (K)"
                      className="fld-i money"
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button
                      onClick={() => {
                        const code = manualCode.trim();
                        if (!code) return;
                        addSelItem({ item_code: code, item_description: null, qty: 1 });
                        setManualCode("");
                      }}
                      disabled={!manualCode.trim()}
                      className="tinybtn"
                      style={{ flex: "none", padding: "0 14px", opacity: manualCode.trim() ? 1 : 0.5 }}
                    >
                      Add
                    </button>
                  </div>
                )}
                {!selItems.length && (
                  <div style={{ fontSize: 10, color: GREY, marginTop: 4 }}>Add at least one affected product. Adjust the quantity per product with − / +.</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Issue card (.so-card) — description, category, priority ── */}
          <div className="so-card">
            <div className="so-hd"><h2 className="so-ti">Issue</h2></div>
            <div className="so-bd">
              <label className="fld">
                <span className="fld-l">Issue description *</span>
                <textarea value={complaint} onChange={(e) => setComplaint(e.target.value)} rows={3} placeholder="Describe the issue…" className="fld-i" style={{ resize: "none" }} />
              </label>
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
              <label className="fld">
                <span className="fld-l">Issue number</span>
                <input
                  value={issueNo}
                  onChange={(e) => setIssueNo(e.target.value)}
                  placeholder="Customer complaint / ticket ref"
                  className="fld-i money"
                />
              </label>
              {/* Complaint date — assr_cases.complained_date. Native date input
                  (value = YYYY-MM-DD), defaulted to today (MYT). */}
              <label className="fld">
                <span className="fld-l">Complaint date *</span>
                <input
                  type="date"
                  value={complainedDate}
                  max={todayMyt()}
                  onChange={(e) => setComplainedDate(e.target.value)}
                  className="fld-i money"
                />
              </label>
            </div>
          </div>

          {/* ── Defect photos / videos card (.so-card) — up to 5, uploaded after create ── */}
          <div className="so-card">
            <div className="so-hd"><h2 className="so-ti">Defect photos / videos</h2><span className="so-sub">{files.length} / 5</span></div>
            <div className="so-bd">
              {files.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: FIELD_BG, border: `1px solid ${DIM}`, display: "flex", alignItems: "center", justifyContent: "center", padding: 4 }}>
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
                <label style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, border: "1px dashed #c2c6bd", borderRadius: 11, padding: 18, background: FIELD_BG, cursor: "pointer" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={TEAL} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5" /><path d="M5 20h14" /></svg>
                  <span style={{ fontSize: 13, fontWeight: 700, color: TEAL }}>Add Photos / Videos</span>
                  <input type="file" accept={ATTACH_ACCEPT} multiple style={{ display: "none" }} onChange={onPickFiles} />
                </label>
              )}
              <div style={{ fontSize: 10, color: GREY, marginTop: 7, textAlign: "center" }}>JPG / PNG / WEBP / MP4 / PDF · 5MB each · up to 5 files · drag, drop, or paste</div>
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
              : "Create Service Case"}
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
        {/* first right-side element gets the auto margin so it hugs the right */}
        {note && <span style={{ marginLeft: "auto", fontSize: 10, color: GREY }}>{note}</span>}
        {headRight && <span style={{ marginLeft: note ? 0 : "auto", fontSize: 11, fontWeight: 600, color: INK }}>{headRight}</span>}
        {headSlot && <span style={{ marginLeft: note || headRight ? 8 : "auto", display: "inline-flex" }}>{headSlot}</span>}
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
  headSlot,
  children,
}: {
  title: string;
  fields: EditField[];
  onSave: (body: Record<string, any>) => Promise<void>;
  busy: boolean;
  open?: boolean;
  accent?: string;
  note?: string;
  headSlot?: React.ReactNode;
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
        {headSlot && !editing && <span style={{ marginLeft: note ? 0 : "auto", marginRight: 8, display: "inline-flex" }}>{headSlot}</span>}
        {!editing && (
          <span onClick={startEdit} className="tinybtn" style={{ marginLeft: note || headSlot ? 0 : "auto" }}>Edit</span>
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

// ── Single-field inline edit row (Info stage panels) ──────────────
// Read view is a KV row; tapping it swaps in the input + Save/Cancel.
// Saves null for a cleared value (PATCH stores `?? null`).
function EditRow({
  label,
  value,
  type = "text",
  options,
  mono,
  busy,
  disabled,
  onSave,
}: {
  label: string;
  value: any;
  type?: "text" | "date" | "textarea" | "select";
  options?: { value: string; label: string }[];
  mono?: boolean;
  busy: boolean;
  disabled?: boolean;
  onSave: (v: string | null) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const start = () => {
    if (disabled) return;
    setDraft(type === "date" ? isoDateOnly(value) : value == null ? "" : String(value));
    setEditing(true);
  };
  const save = async () => {
    const v = draft.trim();
    await onSave(v === "" ? null : v);
    setEditing(false);
  };
  if (!editing) {
    const display =
      value == null || value === ""
        ? "—"
        : type === "date"
        ? dm(value)
        : type === "select"
        ? options?.find((o) => o.value === String(value))?.label ?? String(value)
        : String(value);
    return (
      <div
        onClick={start}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "6px 0", borderTop: `1px solid #f4f5f2`, cursor: disabled ? "default" : "pointer" }}
      >
        <span style={{ fontSize: 11, color: MUTED, flex: "none" }}>{label}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span className={mono ? "money" : undefined} style={{ fontSize: 12.5, fontWeight: 600, color: INK, textAlign: "right", whiteSpace: type === "textarea" ? "normal" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{display}</span>
          {!disabled && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={GREY} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4Z" /></svg>
          )}
        </span>
      </div>
    );
  }
  return (
    <div style={{ padding: "6px 0", borderTop: `1px solid #f4f5f2` }}>
      <div className="fld-l" style={{ marginBottom: 4 }}>{label}</div>
      {type === "textarea" ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="fld-i" style={{ resize: "none", width: "100%", boxSizing: "border-box" }} />
      ) : type === "select" ? (
        <select value={draft} onChange={(e) => setDraft(e.target.value)} className="fld-i" style={{ width: "100%" }}>
          {(options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <input type={type === "date" ? "date" : "text"} value={draft} onChange={(e) => setDraft(e.target.value)} className={`fld-i${mono ? " money" : ""}`} style={{ width: "100%", boxSizing: "border-box" }} />
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button onClick={() => setEditing(false)} disabled={busy} className="tinybtn" style={{ flex: 1 }}>Cancel</button>
        <button onClick={save} disabled={busy} className="tinybtn" style={{ flex: 1, background: TEAL, borderColor: TEAL, color: "#fff", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Root cause inline field (Verification panel) — text input with a
// Save affordance that patches verified_root_cause. Kept separate from
// EditRow because the design renders it under the Outcome buttons.
function RootCauseField({ value, busy, onSave }: { value: any; busy: boolean; onSave: (v: string) => Promise<void> }) {
  const initial = value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  // Re-sync the draft when the underlying value changes (after a refetch)
  // and the user hasn't diverged from the previously-seen value.
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setDraft(initial);
  }
  const dirty = draft.trim() !== initial.trim();
  return (
    <label className="fld">
      <span className="fld-l">Root cause</span>
      <div style={{ display: "flex", gap: 7 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="fld-i"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="Verified root cause"
        />
        {dirty && (
          <button
            onClick={() => onSave(draft.trim())}
            disabled={busy}
            className="tinybtn"
            style={{ flex: "none", background: TEAL, borderColor: TEAL, color: "#fff", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "…" : "Save"}
          </button>
        )}
      </div>
    </label>
  );
}

// ── Attachment grid → PUT /:id/attachments?category=… ─────────────
// Shows the passed (pre-filtered) attachments as auth-fetched thumbnails
// (blob URLs) and lets staff capture / pick up to 5 more per batch, all
// tagged with `category`. Used for Issue photos (complaint), QC-issue
// photos (receipt_evidence) and after-repair QC photos (qc). Archive
// routes through the in-app confirm dialog (no naked delete).
function PhotoGrid({
  caseId,
  attachments,
  category,
  label,
  hint,
  accent = TEAL,
  onChanged,
  notify,
  confirm,
}: {
  caseId: number;
  attachments: Any[];
  category: string;
  label: string;
  hint?: string;
  accent?: string;
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
          `/api/assr/${caseId}/attachments?category=${encodeURIComponent(category)}&ext=${ext}&name=${encodeURIComponent(file.name)}`,
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
    <>
      <div className="fld-l" style={{ marginTop: 8 }}>{label} ({attachments.length})</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 6 }}>
        {attachments.map((att, i) => (
          <AttachThumb key={get(att, "id") ?? i} att={att} onArchive={() => archive(att)} />
        ))}
        <label style={{ border: `1px dashed ${accent}`, borderRadius: 11, aspectRatio: "1", background: FIELD_BG, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.6 : 1 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
          <span style={{ fontSize: 9, fontWeight: 700, color: accent }}>{uploading ? `${uploading.done}/${uploading.total}` : "Add"}</span>
          <input
            ref={inputRef}
            type="file"
            accept={ATTACH_ACCEPT}
            multiple
            style={{ display: "none" }}
            disabled={!!uploading}
            onChange={onPick}
          />
        </label>
      </div>
      {hint && <div style={{ fontSize: 10.5, color: GREY, marginTop: 6 }}>{hint}</div>}
    </>
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
    <div style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: FIELD_BG, border: `1px solid ${DIM}` }}>
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
