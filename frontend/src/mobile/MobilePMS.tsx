import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import "./mobile.css";

/* ------------------------------------------------------------------ *
 * Mobile Project (PMS) — list + detail.
 *
 * Presentation ported VERBATIM from the owner's Houzs Mobile.html design
 * (`<section id="project">` + `renderProject`/`projRenderTasks`) onto the
 * .hz-m design classes now in mobile.css (.hdr .ey .pacc .psec-t .pbody
 * .pstage .pdot .docrow .rbadge .tinybtn .pgrid2 .pkv-l .pkv-v .so-row
 * .so-grid .so-k .so-v .spill .sochip). Only the presentation changed —
 * all data-fetching + behaviour is unchanged.
 *
 * Wired to the same /api/projects backend the desktop Projects page uses
 * (row-scoped + page-access-gated server side). The list hits GET
 * /api/projects (returns { data, page, per_page, total }); the detail hits
 * GET /api/projects/:id (returns { project, finance, checklist, sections,
 * section_progress, sales_attendees, _access, ... }).
 *
 * ROLE GATE: the Financial-snapshot section renders ONLY when the user has
 * finance page-access — pageAccess("projects.finances") !== "none". The
 * backend ALSO strips `finance` from the payload for a role whose PMS
 * position lacks FINANCIAL access (defense in depth), so we additionally
 * hide the panel when `finance` came back null.
 * ------------------------------------------------------------------ */

// ── List row (subset of the desktop ProjectRow the list endpoint returns) ──
type ProjectListRow = {
  id: number;
  code: string;
  name: string;
  stage: string | null;
  status: string | null;
  brand: string | null;
  start_date: string | null;
  end_date: string | null;
  state: string | null;
  venue: string | null;
  booth_no: string | null;
  event_type_name: string | null;
  progress_pct?: number | null;
  pic_name: string | null;
  active_section_name?: string | null;
};

type ListResponse = {
  data?: ProjectListRow[];
  // Tolerate alternate envelope keys just in case.
  projects?: ProjectListRow[];
  rows?: ProjectListRow[];
  total?: number;
};

// ── Detail (subset — never crash on missing fields) ──
type ChecklistItem = {
  id: number;
  seq: number;
  title: string;
  role_label: string | null;
  due_date: string | null;
  status: string | null; // pending | done | na | blocked | review | rejected | amended
  section_id: number | null;
  owner_name?: string | null;
  required_perm?: string | null;
  // mig 090 — payment / deposit rows render as multi-state pills instead of a
  // done/pending tick. pill_value stored via the standard checklist PATCH.
  pill_kind?: string | null; // "rental_payment" | "security_deposit" | null
  pill_value?: string | null; // none | unpaid | fully_paid | refunded
  review_status?: string | null; // drives the approve/reject gate
};

// Per-task attachment (mig 050). Grouped by item_id.
type TaskAttachment = {
  id: number;
  item_id: number;
  r2_key: string;
  file_name: string | null;
  mime_type: string | null;
  uploader_name?: string | null;
  uploaded_at?: string | null;
  archived_at?: string | null;
};

type TasklistSection = {
  id: number;
  name: string;
  sort_order: number;
};

type SectionProgress = {
  id: number;
  name: string;
  sort_order: number;
  total: number;
  done: number;
  na: number;
  complete: number;
};

type SalesAttendee = {
  sales_rep_id: number;
  rep_code: string | null;
  rep_name: string | null;
  user_name: string | null;
};

// Setup / dismantle crew + timing (mig 024/083). The detail endpoint
// spreads `p.*` plus JOIN aliases, so these arrive at the top level of
// `project`. setup_start_at / dismantle_start_at are ISO "date T time".
type PhasePhoto = {
  id: number;
  phase: "setup" | "dismantle" | string;
  r2_key: string | null;
  caption: string | null;
  uploaded_by_name?: string | null;
  uploaded_at?: string | null;
};

type ProjectDetail = {
  project: {
    id: number;
    code: string;
    name: string;
    stage: string | null;
    status: string | null;
    brand: string | null;
    start_date: string | null;
    end_date: string | null;
    state: string | null;
    venue: string | null;
    venue_address?: string | null;
    booth_no: string | null;
    organizer?: string | null;
    event_type_name?: string | null;
    duration_days?: number | null;
    pic_id?: number | null;
    pic_name?: string | null;
    payment_status?: string | null;
    archived_at?: string | null;
    // Setup / dismantle logistics (real columns + JOIN aliases).
    setup_start_at?: string | null;
    dismantle_start_at?: string | null;
    setup_driver_user_id?: number | null;
    dismantle_driver_user_id?: number | null;
    setup_lorry_id?: number | null;
    dismantle_lorry_id?: number | null;
    setup_driver_name?: string | null;
    dismantle_driver_name?: string | null;
    setup_lorry_plate?: string | null;
    dismantle_lorry_plate?: string | null;
  };
  stock_transfers?: StockTransfer[];
  finance: {
    rental: number | null;
    contractor_cost: number | null;
    license_fee: number | null;
    misc_cost: number | null;
    deposit_refund: number | null;
    total_sales: number | null;
  } | null;
  finance_lines?: FinanceLine[];
  checklist?: ChecklistItem[];
  checklist_attachments?: TaskAttachment[];
  sections?: TasklistSection[];
  section_progress?: SectionProgress[];
  sales_attendees?: SalesAttendee[];
  attachments?: ProjectAttachment[];
  _access?: {
    level?: string;
    pms?: { canFinancial?: boolean };
  };
};

// Full stock-transfer row (dual-read camelCase ?? snake_case).
type StockTransfer = {
  id: number;
  direction?: string | null;
  confirmed?: number | boolean | null;
  confirmed_at?: string | null;
  confirmedAt?: string | null;
  created_by_name?: string | null;
  createdByName?: string | null;
  confirmed_by_name?: string | null;
  confirmedByName?: string | null;
  transferred_at?: string | null;
  transferredAt?: string | null;
  record_r2_key?: string | null;
  recordR2Key?: string | null;
  file_name?: string | null;
  fileName?: string | null;
};

// Finance ledger line (income/cost). Synthetic sales rows carry source='sales_entry'.
type FinanceLine = {
  id: number;
  kind: string;
  category: string;
  description?: string | null;
  amount: number;
  occurred_at?: string | null;
  occurredAt?: string | null;
  r2_key?: string | null;
  r2Key?: string | null;
  file_name?: string | null;
  fileName?: string | null;
  created_by_name?: string | null;
  createdByName?: string | null;
  auto_source?: string | null;
  autoSource?: string | null;
  source?: string | null;
  source_id?: number | null;
};

type ProjectAttachment = {
  id: number;
  category?: string | null;
  r2_key?: string | null;
  r2Key?: string | null;
  file_name?: string | null;
  fileName?: string | null;
  mime_type?: string | null;
  mimeType?: string | null;
  uploader_name?: string | null;
  uploaderName?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
};

type Lorry = { id: number; plate: string | null; type?: string | null; is_internal?: boolean | null };

// ── Reference-data list rows (populate the write-form selects) ──
type PicUser = { id: number; name: string | null; email: string };
type SalesRepOption = { id: number; code: string | null; name: string | null };
type FleetStaff = { id: number; name: string | null; role_name: string | null; phone?: string | null; company_phone?: string | null; companyPhone?: string | null };

// ── Shared dialog-hook / setter fn types (props into the write blocks) ──
type NotifyFn = (o: { title: string; body?: ReactNode; tone?: "info" | "error" }) => Promise<void>;
type ConfirmFn = (o: { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;
type PromptFn = (o: { title: string; body?: ReactNode; defaultValue?: string; placeholder?: string; confirmLabel?: string; validate?: (v: string) => string | null }) => Promise<string | null>;
type SetBusy = Dispatch<SetStateAction<boolean>>;

// Map the design's 3 rental-payment states onto the project.payment_status
// enum the POST /:id/payment endpoint accepts.
const PAYMENT_OPTS: Array<[string, string]> = [
  ["not_started", "N/A"],
  ["deposit_paid", "Pending"],
  ["paid", "Fully Paid"],
];

// POST /api/projects/:id/payment — sets project.payment_status.
async function patchPayment(
  id: number,
  status: string,
  setBusy: SetBusy,
  notify: NotifyFn,
  reload: () => void,
): Promise<void> {
  setBusy(true);
  try {
    await api.post(`/api/projects/${id}/payment`, { status });
    reload();
  } catch (e) {
    await notify({ title: "Update failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
  } finally {
    setBusy(false);
  }
}

// Dual-read helper — the PG driver camelCases result columns, so a row may
// carry either snake_case (D1 fallback / raw SQL) or camelCase. Always read
// both (project_pg_camelcase_columns memory — #1 recurring bug).
function pick<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v != null) return v;
  return null;
}

// ── Formatters ──
const rm = (v: number | null | undefined) =>
  ((v ?? 0)).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dm = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(+dt)) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
// Date-only portion of an ISO "date T time" string (setup_start_at etc).
const dOnly = (d: string | null | undefined) => dm(d);
// Time-only portion ("08:00"). Reads the literal HH:mm off the ISO string so
// it doesn't shift with the device timezone; falls back to "—".
const tOnly = (d: string | null | undefined) => {
  if (!d) return "—";
  const m = /T(\d{2}:\d{2})/.exec(d);
  if (m) return m[1];
  const dt = new Date(d);
  if (isNaN(+dt)) return "—";
  return dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
};
// Uploader credit line: "Uploaded by {name} · {date time}" or a placeholder.
const uploaderCredit = (photo: PhasePhoto | undefined) => {
  if (!photo) return "Not uploaded yet";
  const who = photo.uploaded_by_name?.trim();
  const when = photo.uploaded_at ? `${dm(photo.uploaded_at)} ${tOnly(photo.uploaded_at)}` : null;
  return ["Uploaded by " + (who || "crew"), when].filter(Boolean).join(" · ");
};

// ── Stage / status vocab ──
// The backend `stage` model (mig 053): draft → setup → live → dismantle →
// completed. The owner's mobile design shows a richer 9-step logistics
// pipeline (Floorplan → Done). We drive the pipeline off the project's
// checklist SECTIONS when present (that is what the desktop tracker uses),
// and fall back to a fixed 9-step reference pipeline keyed off `stage`.
// Designer's 9-step reference pipeline (MobilePMS PIPELINE), VERBATIM.
const FALLBACK_PIPELINE = [
  "Confirmed",
  "Setup",
  "Floorplan",
  "3D",
  "Stocks Transfer",
  "Setup/Dismantle",
  "Filled Floorplan",
  "Event Complete",
  "Done",
];

// Map the coarse backend stage onto an approximate pipeline index so the
// fallback pipeline highlights a plausible "current" step.
const STAGE_TO_INDEX: Record<string, number> = {
  draft: 1,
  setup: 2,
  live: 6,
  dismantle: 5,
  completed: 8,
};

// ── Component ──
export function MobilePMS({ onBack, initialProjectId }: { onBack?: () => void; initialProjectId?: number }) {
  const [openId, setOpenId] = useState<number | null>(initialProjectId ?? null);
  // When entered straight into a detail (e.g. tapped from the Calendar), Back
  // leaves PMS entirely; once the user visits the list, Back returns to it.
  const [direct, setDirect] = useState<boolean>(initialProjectId != null);

  if (openId != null) {
    return <ProjectDetailView id={openId} onBack={() => (direct ? onBack?.() : setOpenId(null))} />;
  }
  return <ProjectListView onOpen={(id) => { setDirect(false); setOpenId(id); }} onBack={onBack} />;
}

// ── List ──
function ProjectListView({ onOpen, onBack }: { onOpen: (id: number) => void; onBack?: () => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-pms-list"],
    queryFn: () => api.get<ListResponse>("/api/projects?per_page=200"),
    staleTime: 30_000,
  });
  const all = data?.data ?? data?.projects ?? data?.rows ?? [];

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (status !== "all" && (r.status ?? "").toLowerCase() !== status.toLowerCase()) return false;
      if (needle) {
        const hay = `${r.code} ${r.name} ${r.brand ?? ""} ${r.venue ?? ""} ${r.pic_name ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [all, q, status]);

  const STATUS_FILTERS: [string, string][] = [
    ["all", "All"],
    ["confirmed", "Confirmed"],
    ["pending", "Pending"],
    ["cancelled", "Cancelled"],
  ];

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {onBack && (
              <span onClick={onBack} role="button" aria-label="Back" style={{ fontSize: 22, lineHeight: 1, color: "var(--brand)", cursor: "pointer" }}>‹</span>
            )}
            <div>
              <div className="eyebrow">PMS</div>
              <div className="scr-title">Projects</div>
            </div>
          </div>
        </div>
        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search project · venue" />
          </div>
        </div>
        <div className="chips" style={{ marginTop: 11 }}>
          {STATUS_FILTERS.map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)} className={status === k ? "chip on" : "chip"}>{label}</button>
          ))}
        </div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>

        {isLoading && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't load projects. Pull to retry.</div>}
        {!isLoading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {rows.map((r) => {
              const cancelled = (r.status ?? "").toLowerCase() === "cancelled";
              const stage = r.active_section_name || r.stage || null;
              const where = r.venue || r.state || null;
              const dates = [dm(r.start_date), dm(r.end_date)].join(" – ");
              return (
                <div key={r.id} onClick={() => onOpen(r.id)} className={cancelled ? "card cancelled" : "card"} style={{ cursor: "pointer", ...(cancelled ? { opacity: 0.55, filter: "grayscale(.5)" } : null) }}>
                  <div className="card-b" style={{ padding: "12px 13px" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", lineHeight: 1.3 }}>{r.name || "—"}</span>
                      <StatusPill status={r.status} />
                    </div>
                    {(r.brand || where || stage) && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        {r.brand && <ListChip>{r.brand}</ListChip>}
                        {where && <ListChip>{where}</ListChip>}
                        {stage && <ListChip>{stage}</ListChip>}
                      </div>
                    )}
                    <div className="tnum" style={{ fontSize: 11, color: "var(--mut)", marginTop: 8, paddingTop: 8, borderTop: "1px solid #f0f1ed" }}>
                      {dates} · {r.code || "—"}{r.pic_name ? ` · PIC ${r.pic_name}` : ""}
                    </div>
                  </div>
                </div>
              );
            })}
            {!rows.length && (
              <div className="empty">
                <div className="empty-t">No projects</div>
                <div className="empty-s">No projects match this filter.</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detail ──
function ProjectDetailView({ id, onBack }: { id: number; onBack: () => void }) {
  const { pageAccess, can } = useAuth();
  // Finance-gate key mirrors the desktop Projects page (usePageAccess).
  const canSeeFinance = pageAccess("projects.finances") !== "none";
  // Sales quick-log gate (the Sales page-access, mirrors desktop).
  const salesAccess = pageAccess("sales");
  const canLogSale = salesAccess !== "none";
  const canWrite = can("projects.write");
  const canManage = can("projects.manage");
  const canTick = canWrite || can("projects.checklist.tick");

  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-pms-detail", id],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${id}`),
    staleTime: 15_000,
  });

  // Crew-uploaded setup/dismantle evidence photos (mig 084) live on a
  // separate endpoint. Used only for the uploader credit on the Setup &
  // dismantle block — a 403 (no phase access) just yields no credit.
  const { data: photoData } = useQuery({
    queryKey: ["mobile-pms-phase-photos", id],
    queryFn: () => api.get<{ photos: PhasePhoto[] }>(`/api/projects/${id}/phase-photos`),
    staleTime: 15_000,
    retry: false,
  });
  const photos = photoData?.photos ?? [];

  // Reference-data for the write forms. All best-effort (retry:false): a rep
  // whose token lacks the perm gets 403 → empty list → the select just shows
  // the current value with no options, never crashes.
  const picUsersQ = useQuery({
    queryKey: ["mobile-pms-pic-users"],
    queryFn: () => api.get<{ users: PicUser[] }>(`/api/users?department=${encodeURIComponent("Sales")}`),
    staleTime: 5 * 60_000,
    enabled: canWrite,
    retry: false,
  });
  const picUsers = picUsersQ.data?.users ?? [];

  const salesRepsQ = useQuery({
    queryKey: ["mobile-pms-sales-reps"],
    queryFn: () => api.get<{ data: SalesRepOption[] }>(`/api/projects/sales-rep-options`),
    staleTime: 5 * 60_000,
    enabled: canWrite,
    retry: false,
  });
  const salesReps = salesRepsQ.data?.data ?? [];

  const fleetQ = useQuery({
    queryKey: ["mobile-pms-fleet"],
    queryFn: () => api.get<{ data: FleetStaff[] }>(`/api/fleet/staff`),
    staleTime: 5 * 60_000,
    enabled: canWrite,
    retry: false,
  });
  const drivers = useMemo(
    () => (fleetQ.data?.data ?? []).filter((s) => (s.role_name ?? "").toLowerCase() === "driver"),
    [fleetQ.data],
  );

  // Lorry list (GET /api/scm/lorries → { lorries: [...] }). Best-effort; a
  // reader without scm access gets [] and the picker shows only the current value.
  const lorriesQ = useQuery({
    queryKey: ["mobile-pms-lorries"],
    queryFn: () => api.get<{ lorries: Lorry[] }>(`/api/scm/lorries`),
    staleTime: 5 * 60_000,
    enabled: canWrite,
    retry: false,
  });
  const lorries = lorriesQ.data?.lorries ?? [];

  // Mark the project read when the detail opens (drives the unread bell).
  useEffect(() => {
    api.post(`/api/projects/${id}/read`).catch(() => {});
  }, [id]);

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["mobile-pms-detail", id] });
    void qc.invalidateQueries({ queryKey: ["mobile-pms-list"] });
  };
  const reloadPhotos = () => qc.invalidateQueries({ queryKey: ["mobile-pms-phase-photos", id] });

  // Central PATCH /:id helper (project-detail edits, PIC, status, stage,
  // setup/dismantle logistics). Surfaces the "shifted N tasks" hint the
  // backend returns when a date move re-dates the checklist.
  const patchProject = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await api.patch<{ shifted_tasks?: number; delta_days?: number }>(`/api/projects/${id}`, body);
      reload();
      if (res?.shifted_tasks && res.shifted_tasks > 0) {
        const days = res.delta_days ?? 0;
        await notify({
          title: "Saved",
          body: `Shifted ${res.shifted_tasks} task${res.shifted_tasks === 1 ? "" : "s"} ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "forward" : "back"}.`,
        });
      }
      return true;
    } catch (e) {
      await notify({ title: "Save failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const p = data?.project;
  const archived = !!p?.archived_at;
  // Show finance only when the user has the page-access AND the backend
  // actually returned the finance block (it strips it server-side for a
  // role whose PMS position lacks FINANCIAL). Gating follows the real
  // backend permission — no in-screen view-as switcher (removed to match v4).
  const financeVisible = canSeeFinance && !!data?.finance;

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr" style={{ background: "var(--ink-dark)", borderBottom: "none" }}>
        <div className="hdr-row" style={{ marginBottom: 10, gap: 7 }}>
          <button className="back" onClick={onBack} aria-label="Back to list" style={{ color: "#d8a85a" }}>
            <span className="chev">‹</span> Projects
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {p && canManage && (
              <button
                className="tinybtn"
                disabled={busy}
                style={{ background: "rgba(255,255,255,.08)", borderColor: "rgba(231,234,228,.18)", color: "#e7eae4" }}
                onClick={async () => {
                  if (archived) {
                    setBusy(true);
                    try {
                      await api.post(`/api/projects/${id}/unarchive`);
                      reload();
                    } catch (e) {
                      await notify({ title: "Restore failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
                    } finally { setBusy(false); }
                    return;
                  }
                  if (!(await confirm({ title: "Archive this project?", confirmLabel: "Archive", danger: true }))) return;
                  setBusy(true);
                  try {
                    await api.post(`/api/projects/${id}/archive`);
                    reload();
                  } catch (e) {
                    await notify({ title: "Archive failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
                  } finally { setBusy(false); }
                }}
              >
                {archived ? "Restore" : "Archive"}
              </button>
            )}
            {p && canWrite && !archived && (
              <select
                value={p.status ?? ""}
                disabled={busy}
                onChange={(e) => { void patchProject({ status: e.target.value }); }}
                className="tinybtn"
                style={{ background: "rgba(216,168,90,.16)", borderColor: "rgba(216,168,90,.4)", color: "#d8a85a" }}
                aria-label="Change status"
              >
                <option value="confirmed">Confirmed</option>
                <option value="pending">Pending</option>
                <option value="cancelled">Cancelled</option>
              </select>
            )}
            {p?.status && (!canWrite || archived) && <StatusPill status={p.status} dark />}
          </div>
        </div>
        {/* Title block — design VERBATIM: project name as the sole heading
            (16px/800), no eyebrow. Meta line carries our real code/brand data. */}
        <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", lineHeight: 1.3, marginTop: 6 }}>{p?.name || "—"}</div>
        <div style={{ fontSize: 11.5, color: "#8c968a", marginTop: 5 }}>
          {[p?.code, p?.brand, p?.event_type_name, p?.venue].filter(Boolean).join(" · ") || "—"}
        </div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {isLoading && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't load this project.</div>}

        {!isLoading && !error && data && p && (
          <>
            {/* stage pipeline (design "Pipeline" card) */}
            <StagePipeline stage={p.stage} sections={data.section_progress} />

            {/* project detail */}
            <details className="pacc" open>
              <summary>
                <span className="psec-t">Project</span>
                {canWrite && !archived && (
                  <span
                    role="button"
                    className="tinybtn"
                    style={{ marginLeft: "auto" }}
                    onClick={async (e) => {
                      e.preventDefault();
                      if (busy) return;
                      // Sequential single-field prompts (usePrompt returns one
                      // value); each null/cancel ends the flow, blanks are skipped.
                      const fields: Array<[string, string, string | null | undefined]> = [
                        ["name", "Project name", p.name],
                        ["booth_no", "Booth number", p.booth_no],
                        ["venue", "Venue", p.venue],
                        ["organizer", "Organizer", p.organizer],
                        ["start_date", "Start date (YYYY-MM-DD)", p.start_date],
                        ["end_date", "End date (YYYY-MM-DD)", p.end_date],
                      ];
                      const patch: Record<string, unknown> = {};
                      for (const [key, label, cur] of fields) {
                        const val = await prompt({ title: `Edit ${label}`, placeholder: label, defaultValue: (cur ?? "") as string });
                        if (val == null) break; // cancelled — stop the flow
                        const t = val.trim();
                        if (key === "name" && !t) continue; // name can't be blanked
                        if (t !== (cur ?? "")) patch[key] = t || null;
                      }
                      if (Object.keys(patch).length > 0) await patchProject(patch);
                    }}
                  >
                    Edit
                  </span>
                )}
                <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </summary>
              {/* Body — design "Project" card rows VERBATIM: Dates / Venue /
                  Organizer / Branding, wired to our real columns. */}
              <div className="pbody">
                <div className="row" style={{ borderTop: "none" }}><span className="row-l">Dates</span><span className="row-v money">{dm(p.start_date)} – {dm(p.end_date)}</span></div>
                <div className="row"><span className="row-l">Venue</span><span className="row-v">{p.venue || p.state || "—"}</span></div>
                <div className="row"><span className="row-l">Organizer</span><span className="row-v">{p.organizer || "—"}</span></div>
                <div className="row" style={{ borderBottom: "none" }}><span className="row-l">Branding</span><span className="row-v">{p.brand || "—"}</span></div>
              </div>
            </details>

            {/* project team */}
            <details className="pacc" open>
              <summary>
                <span className="psec-t">Team</span>
                <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </summary>
              <div className="pbody">
                {canWrite && !archived ? (
                  <label className="fld" style={{ marginBottom: 10 }}>
                    <span className="fld-l">PIC</span>
                    <select
                      className="fld-i"
                      disabled={busy}
                      value={p.pic_id ?? ""}
                      onChange={(e) => { const v = e.target.value; void patchProject({ pic_id: v ? parseInt(v, 10) : null }); }}
                    >
                      <option value="">— unassigned —</option>
                      {p.pic_id != null && p.pic_name && !picUsers.some((u) => u.id === p.pic_id) && (
                        <option value={p.pic_id}>{p.pic_name} (out of scope)</option>
                      )}
                      {picUsers.map((u) => (
                        <option key={u.id} value={u.id}>{u.name || u.email}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="pgrid2" style={{ marginBottom: 10 }}>
                    <div style={{ gridColumn: "1 / -1" }}><div className="pkv-l">PIC</div><div className="pkv-v">{p.pic_name || "—"}</div></div>
                  </div>
                )}
                <SalesAttending
                  projectId={id}
                  attendees={data.sales_attendees ?? []}
                  options={salesReps}
                  canWrite={canWrite && !archived}
                  busy={busy}
                  setBusy={setBusy}
                  notify={notify}
                  confirm={confirm}
                  reload={reload}
                />
              </div>
            </details>

            {/* tasklist */}
            <TasklistSectionView
              sections={data.sections}
              items={data.checklist}
              progress={data.section_progress}
              attachments={data.checklist_attachments}
              canTick={canTick && !archived}
              can={can}
              busy={busy}
              setBusy={setBusy}
              notify={notify}
              prompt={prompt}
              projectId={id}
              reload={reload}
            />

            {/* setup & dismantle (logistic) */}
            <SetupDismantle
              projectId={id}
              project={p}
              photos={photos}
              drivers={drivers}
              lorries={lorries}
              canWrite={canWrite && !archived}
              busy={busy}
              setBusy={setBusy}
              patchProject={patchProject}
              notify={notify}
              reloadPhotos={reloadPhotos}
            />

            {/* floor plans & layout + stock transfers (upload-only) */}
            <FloorPlans
              projectId={id}
              stockTransfers={data.stock_transfers}
              attachments={data.attachments}
              canWrite={canWrite && !archived}
              busy={busy}
              setBusy={setBusy}
              notify={notify}
              reload={reload}
            />

            {/* rental & payment */}
            <RentalPayment
              status={p.payment_status ?? null}
              canWrite={canWrite && !archived}
              busy={busy}
              setBusy={setBusy}
              notify={notify}
              onSet={(status) => patchPayment(id, status, setBusy, notify, reload)}
            />

            {/* financial snapshot (finance-gated) — design v7 places P&L as the
                FINAL card, after the logistics + money sections. */}
            {financeVisible && (
              <FinancialSnapshot
                finance={data.finance!}
                lines={data.finance_lines}
                canLogSale={canLogSale && !archived}
                busy={busy}
                setBusy={setBusy}
                prompt={prompt}
                notify={notify}
                projectId={id}
                reload={reload}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Sales attending (add via picker + remove) ──
function SalesAttending({
  projectId, attendees, options, canWrite, busy, setBusy, notify, confirm, reload,
}: {
  projectId: number;
  attendees: SalesAttendee[];
  options: SalesRepOption[];
  canWrite: boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  confirm: ConfirmFn;
  reload: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const present = new Set(attendees.map((a) => a.sales_rep_id));
  const available = options.filter((o) => !present.has(o.id));

  const add = async () => {
    const repId = parseInt(pick, 10);
    if (!Number.isFinite(repId)) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/sales-attendees`, { sales_rep_id: repId });
      setPick("");
      setAdding(false);
      reload();
    } catch (e) {
      await notify({ title: "Failed to add", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: SalesAttendee) => {
    const label = a.rep_name || a.user_name || `Rep #${a.sales_rep_id}`;
    if (!(await confirm({ title: "Remove from attendance?", body: `${label} will no longer be listed as attending.`, confirmLabel: "Remove", danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/api/projects/${projectId}/sales-attendees/${a.sales_rep_id}`);
      reload();
    } catch (e) {
      await notify({ title: "Failed to remove", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093" }}>Sales attending</span>
        {canWrite && !adding && available.length > 0 && (
          <button className="tinybtn" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setAdding(true)}>+ Add</button>
        )}
      </div>
      {adding && (
        <div style={{ display: "flex", gap: 7, marginBottom: 8 }}>
          <select className="fld-i" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1 }} disabled={busy}>
            <option value="">Select a rep…</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>{[o.name || `#${o.id}`, o.code].filter(Boolean).join(" · ")}</option>
            ))}
          </select>
          <button className="tinybtn" style={{ background: "#16695f", borderColor: "#16695f", color: "#fff" }} disabled={busy || !pick} onClick={add}>Add</button>
          <button className="tinybtn" disabled={busy} onClick={() => { setAdding(false); setPick(""); }}>Cancel</button>
        </div>
      )}
      {attendees.length === 0 && <div style={{ fontSize: 12, color: "#9aa093" }}>None assigned.</div>}
      {attendees.length > 0 && (
        <div style={{ border: "1px solid #e3e6e0", borderRadius: 10, overflow: "hidden" }}>
          {attendees.map((s, i) => (
            <div key={s.sales_rep_id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderTop: i === 0 ? "none" : "1px solid #eceee9" }}>
              <span className="money" style={{ fontSize: 10, color: "#9aa093" }}>{s.rep_code || "—"}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#11140f", flex: 1, minWidth: 0 }}>{s.rep_name || s.user_name || "—"}</span>
              {canWrite && (
                <button aria-label="Remove" className="tinybtn" disabled={busy} style={{ padding: "3px 7px" }} onClick={() => remove(s)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Rental & payment (N/A / Pending / Fully Paid → POST /:id/payment) ──
function RentalPayment({
  status, canWrite, busy, setBusy, notify, onSet,
}: {
  status: string | null;
  canWrite: boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  onSet: (status: string) => Promise<void>;
}) {
  void setBusy; void notify; // handled inside onSet (patchPayment)
  const cur = status ?? "not_started";
  return (
    <details className="pacc">
      <summary>
        <span className="psec-t">Rental &amp; payment</span>
        <PaymentBadge status={cur} />
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        <div className="docrow" style={{ borderTop: "none" }}>
          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "#11140f" }}>Rental Payment</span>
          {canWrite ? (
            PAYMENT_OPTS.map(([v, label]) => {
              const on = v === cur;
              const tone = v === "not_started"
                ? { bg: on ? "#f4f6f3" : "#fff", fg: "#767b6e" }
                : v === "deposit_paid"
                  ? { bg: on ? "#f6efd9" : "#fff", fg: "#6e4d12", border: "#e8dcc5" }
                  : { bg: on ? "#e2f0e9" : "#fff", fg: "#2f8a5b", border: "#bcdcd7" };
              return (
                <button
                  key={v}
                  className="tinybtn"
                  disabled={busy || on}
                  style={{ background: tone.bg, color: tone.fg, borderColor: tone.border ?? "#d6d9d2", fontWeight: on ? 800 : 700 }}
                  onClick={() => { void onSet(v); }}
                >
                  {label}
                </button>
              );
            })
          ) : (
            <span className="pkv-v" style={{ marginTop: 0 }}>{humanize(cur)}</span>
          )}
        </div>
      </div>
    </details>
  );
}

// ── Pipeline (design VERBATIM — flat rounded-pill row in a card) ──
// Designer render (`MobilePMS` "Pipeline" card): a horizontal-scroll strip of
// rounded pills; the reached steps read green, the rest grey. We drive the
// reached count off the project's real checklist SECTIONS when present (the
// desktop tracker's source of truth), falling back to the coarse backend
// `stage`. The 9 pill labels + colours are the designer's.
function StagePipeline({ stage, sections }: { stage: string | null; sections?: SectionProgress[] }) {
  let labels: string[];
  let reached: number; // number of steps considered "done" (green)
  if (sections && sections.length) {
    const ordered = [...sections].sort((a, b) => a.sort_order - b.sort_order);
    labels = ordered.map((s) => s.name);
    // First not-complete section is the current step; everything before it done.
    const firstOpen = ordered.findIndex((s) => !s.complete);
    reached = firstOpen === -1 ? ordered.length : firstOpen;
  } else {
    labels = FALLBACK_PIPELINE;
    reached = STAGE_TO_INDEX[(stage ?? "").toLowerCase()] ?? 0;
  }

  return (
    <div className="card"><div className="card-b">
      <div className="fld-l" style={{ marginBottom: 8 }}>Pipeline</div>
      <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 4 }}>
        {labels.map((label, i) => (
          <span
            key={`${label}-${i}`}
            style={{
              flex: "none",
              fontSize: 10,
              fontWeight: 700,
              padding: "5px 9px",
              borderRadius: 20,
              background: i < reached ? "#e2f0e9" : "#f4f6f3",
              color: i < reached ? "#2f8a5b" : "#9aa093",
            }}
          >
            {label}
          </span>
        ))}
      </div>
    </div></div>
  );
}

// ── Tasklist ──
// Role-badge colours mirror the design's PROJ_TASKS palette, keyed by the
// checklist item's `role_label` (BD / PURCHASER / DRIVER / SALES PIC …).
const ROLE_COLOR: Record<string, string> = {
  BD: "#7a5c86",
  PURCHASER: "#a16a2e",
  DRIVER: "#2a6f9e",
  "SALES PIC": "#16695f",
  SALES: "#16695f",
  LOGISTIC: "#2f8a5b",
};
const roleColor = (label: string) => ROLE_COLOR[label.toUpperCase()] ?? "#767b6e";

// Checklist status cycle for the tick control: pending → done → na → pending.
const NEXT_STATUS: Record<string, "pending" | "done" | "na"> = {
  pending: "done",
  done: "na",
  na: "pending",
  blocked: "done",
};

function TasklistSectionView({
  projectId, sections, items, progress, attachments, canTick, can, busy, setBusy, notify, prompt, reload,
}: {
  projectId: number;
  sections?: TasklistSection[];
  items?: ChecklistItem[];
  progress?: SectionProgress[];
  attachments?: TaskAttachment[];
  canTick: boolean;
  can: (perm: string) => boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  prompt: PromptFn;
  reload: () => void;
}) {
  const list = items ?? [];
  const secs = sections ?? [];

  const attachBySection = useMemo(() => {
    const m = new Map<number, TaskAttachment[]>();
    for (const a of attachments ?? []) {
      if (a.archived_at) continue;
      const arr = m.get(a.item_id) ?? [];
      arr.push(a);
      m.set(a.item_id, arr);
    }
    return m;
  }, [attachments]);
  // Group items by section_id; keep an "Uncategorised" bucket for null.
  const bySection = useMemo(() => {
    const m = new Map<number, ChecklistItem[]>();
    for (const it of list) {
      const key = it.section_id ?? 0;
      const arr = m.get(key) ?? [];
      arr.push(it);
      m.set(key, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.seq - b.seq);
    return m;
  }, [list]);

  const orderedSecs = [...secs].sort((a, b) => a.sort_order - b.sort_order);
  const progressById = new Map((progress ?? []).map((p) => [p.id, p]));

  const renderRows = (rows: ChecklistItem[]) =>
    rows.map((it) => (
      <TaskRow
        key={it.id}
        item={it}
        attachments={attachBySection.get(it.id) ?? []}
        canTick={canTick}
        can={can}
        busy={busy}
        setBusy={setBusy}
        notify={notify}
        prompt={prompt}
        reload={reload}
      />
    ));

  const totalTasks = list.length;

  return (
    <details className="pacc" open>
      <summary>
        <span className="psec-t">{`Tasklist${totalTasks ? ` (${totalTasks})` : ""}`}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#9aa093" }}>List · Section</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        {totalTasks === 0 && !orderedSecs.length && <div style={{ fontSize: 12, color: "#9aa093" }}>No tasks yet.</div>}
        {orderedSecs.map((sec) => {
          const rows = bySection.get(sec.id) ?? [];
          const prog = progressById.get(sec.id);
          return (
            <div key={sec.id} style={{ marginTop: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0 2px" }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#11140f" }}>{sec.name}</span>
                {prog && <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: "#9aa093" }}>{prog.done}/{prog.total}</span>}
              </div>
              {rows.length ? renderRows(rows) : <div style={{ fontSize: 11, color: "#9aa093", padding: "4px 0" }}>No tasks in this section.</div>}
            </div>
          );
        })}
        {/* Uncategorised bucket */}
        {(() => {
          const rows = bySection.get(0) ?? [];
          if (!rows.length) return null;
          return (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0 2px" }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#11140f" }}>Uncategorised</span>
              </div>
              {renderRows(rows)}
            </div>
          );
        })()}
      </div>
    </details>
  );
}

// One checklist row. Tick cycles status (POST /checklist/:id/status); the
// paperclip uploads a per-task attachment (PUT /checklist/:id/attachments) and
// the "…" opens remark / approval. Payment-pill rows (mig 090) render N/A /
// PENDING / PAID buttons instead of the tick, saved via PATCH /checklist/:id.
function TaskRow({
  item: it, attachments, canTick, can, busy, setBusy, notify, prompt, reload,
}: {
  item: ChecklistItem;
  attachments: TaskAttachment[];
  canTick: boolean;
  can: (perm: string) => boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  prompt: PromptFn;
  reload: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const status = (it.status ?? "").toLowerCase();
  const done = status === "done";
  const na = status === "na";
  const c = it.role_label ? roleColor(it.role_label) : null;
  // A row the caller can't tick because it needs a specific permission.
  const permBlocked = !!it.required_perm && !can(it.required_perm);
  const canRowTick = canTick && !permBlocked;

  const cycle = async () => {
    if (!canRowTick || busy) return;
    const next = NEXT_STATUS[status] ?? "done";
    setBusy(true);
    try {
      await api.post(`/api/projects/checklist/${it.id}/status`, { status: next });
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const setPill = async (v: string) => {
    if (v === (it.pill_value || "unpaid") || busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/projects/checklist/${it.id}`, { pill_value: v });
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 10MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      await api.putBinary(
        `/api/projects/checklist/${it.id}/attachments?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}`,
        buf,
        file.type || "application/octet-stream",
      );
      reload();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Approve / reject a task awaiting review (gated by required_perm).
  // reject needs a reason.
  const review = async (action: "approve" | "reject") => {
    const body: Record<string, unknown> = { action };
    if (action === "reject") {
      const reason = await prompt({ title: `Reject "${it.title}"?`, placeholder: "Reason (required)", validate: (v) => (v.trim() ? null : "A reason is required.") });
      if (reason == null || !reason.trim()) return;
      body.reason = reason.trim();
    }
    setBusy(true);
    try {
      await api.post(`/api/projects/checklist/${it.id}/review`, body);
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  // Payment / deposit pill rows: N/A / PENDING / PAID instead of the tick.
  if (it.pill_kind) {
    const opts: Array<[string, string]> =
      it.pill_kind === "rental_payment"
        ? [["none", "N/A"], ["unpaid", "PENDING"], ["fully_paid", "PAID"]]
        : [["none", "N/A"], ["unpaid", "PENDING"], ["refunded", "REFUNDED"]];
    const cur = it.pill_value || "unpaid";
    return (
      <div className="docrow" style={{ flexWrap: "wrap" }}>
        <span style={{ width: 15, height: 15, flex: "none" }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "#11140f" }}>{it.title}</span>
        {it.role_label && c && <span className="rbadge" style={{ background: `${c}1f`, color: c }}>{it.role_label}</span>}
        {opts.map(([v, label]) => {
          const on = v === cur;
          return (
            <button
              key={v}
              className="tinybtn"
              disabled={!canTick || busy || on}
              style={{ background: on ? (v === "none" ? "#f4f6f3" : v === "unpaid" ? "#f6efd9" : "#e2f0e9") : "#fff", color: v === "none" ? "#767b6e" : v === "unpaid" ? "#6e4d12" : "#2f8a5b", fontWeight: on ? 800 : 700 }}
              onClick={() => setPill(v)}
            >
              {label}
            </button>
          );
        })}
      </div>
    );
  }

  const reviewStatus = (it.review_status ?? "").toLowerCase();
  const awaitingReview = reviewStatus === "pending_review" || reviewStatus === "amended";
  return (
    <div style={{ borderTop: "1px solid #eceee9" }}>
    <div className="docrow" style={{ flexWrap: "wrap", borderTop: "none" }}>
      <span
        role={canRowTick ? "button" : undefined}
        onClick={cycle}
        title={permBlocked ? `Requires ${it.required_perm}` : canRowTick ? "Cycle status" : undefined}
        style={{ flex: "none", display: "flex", cursor: canRowTick ? "pointer" : "default", opacity: busy ? 0.6 : 1 }}
      >
        {done ? (
          <span style={{ width: 15, height: 15, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: "#2f8a5b" }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        ) : na ? (
          <span style={{ width: 15, height: 15, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid #d6d9d2", fontSize: 8, fontWeight: 800, color: "#9aa093" }}>N</span>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /></svg>
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: na ? "#9aa093" : "#11140f", textDecoration: na ? "line-through" : "none" }}>{it.title}</span>
      {it.role_label && c && <span className="rbadge" style={{ background: `${c}1f`, color: c }}>{it.role_label}</span>}
      {it.due_date && <span style={{ fontSize: 9.5, color: "#9aa093", whiteSpace: "nowrap" }}>{dm(it.due_date)}</span>}
      {canTick && (
        <>
          <input ref={fileRef} type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button className="tinybtn" disabled={busy} onClick={() => fileRef.current?.click()} title={attachments.length ? `${attachments.length} file(s)` : "Attach"}>
            {attachments.length ? `Attach (${attachments.length})` : "Attach"}
          </button>
        </>
      )}
      {canTick && awaitingReview && (
        <>
          <button className="tinybtn" style={{ background: "#e2f0e9", borderColor: "#bcdcd7", color: "#2f8a5b" }} disabled={busy} onClick={() => review("approve")}>Approve</button>
          <button className="tinybtn" style={{ background: "#f7e7e5", borderColor: "#e6c9c6", color: "#a13a34" }} disabled={busy} onClick={() => review("reject")}>Reject</button>
        </>
      )}
    </div>
    {reviewStatus && reviewStatus !== "approved" && (
      <div style={{ padding: "0 0 6px 24px" }}>
        <span className="rbadge" style={{ background: reviewStatus === "rejected" ? "#f7e7e5" : "#f6efd9", color: reviewStatus === "rejected" ? "#a13a34" : "#6e4d12" }}>{humanize(reviewStatus).toUpperCase()}</span>
      </div>
    )}
    </div>
  );
}

// Split an ISO "date T time" into the parts an <input type=date/time> wants.
const isoDatePart = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : "";
};
const isoTimePart = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : "";
};

// ── Setup & dismantle (logistic) ──
// Editable per-phase schedule (date + start time), driver picker + lorry
// picker (GET /api/scm/lorries), plus a real photo upload (two-step:
// PUT /:id/phase-photos/upload → POST /:id/phase-photos). Schedule/driver/
// lorry all persist via PATCH /:id.
function SetupDismantle({
  projectId, project, photos, drivers, lorries, canWrite, busy, setBusy, patchProject, notify, reloadPhotos,
}: {
  projectId: number;
  project: ProjectDetail["project"];
  photos: PhasePhoto[];
  drivers: FleetStaff[];
  lorries: Lorry[];
  canWrite: boolean;
  busy: boolean;
  setBusy: SetBusy;
  patchProject: (body: Record<string, unknown>) => Promise<boolean>;
  notify: NotifyFn;
  reloadPhotos: () => void;
}) {
  const setupPhoto = photos.find((ph) => ph.phase === "setup");
  const dismantlePhoto = photos.find((ph) => ph.phase === "dismantle");

  const anyData =
    project.setup_start_at || project.dismantle_start_at ||
    project.setup_driver_name || project.dismantle_driver_name ||
    project.setup_lorry_plate || project.dismantle_lorry_plate || photos.length > 0;

  return (
    <details className="pacc">
      <summary>
        <span className="psec-t">Setup &amp; dismantle</span>
        <span className="rbadge" style={{ marginLeft: "auto", background: "#e2f0e9", color: "#2f8a5b" }}>LOGISTIC</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        {!anyData && !canWrite && <div style={{ fontSize: 12, color: "#9aa093", marginBottom: 12 }}>No setup or dismantle logistics assigned yet.</div>}
        <PhaseBlock
          kind="Setup"
          projectId={projectId}
          project={project}
          photo={setupPhoto}
          drivers={drivers}
          lorries={lorries}
          canWrite={canWrite}
          busy={busy}
          setBusy={setBusy}
          patchProject={patchProject}
          notify={notify}
          reloadPhotos={reloadPhotos}
        />
        <div style={{ height: 1, background: "#e3e6e0", margin: "14px 0" }} />
        <PhaseBlock
          kind="Dismantle"
          projectId={projectId}
          project={project}
          photo={dismantlePhoto}
          drivers={drivers}
          lorries={lorries}
          canWrite={canWrite}
          busy={busy}
          setBusy={setBusy}
          patchProject={patchProject}
          notify={notify}
          reloadPhotos={reloadPhotos}
        />
      </div>
    </details>
  );
}

// Staff name with phone in parens when available (mirrors the prototype's
// "Faiz Rahman (012-880 5567)" driver option). Dual-reads phone / company_phone.
function staffLabel(o: FleetStaff): string {
  const name = o.name || `#${o.id}`;
  const ph = o.phone ?? o.company_phone ?? o.companyPhone ?? null;
  return ph ? `${name} (${ph})` : name;
}

// A driver/helper picker that always renders the current out-of-scope value
// (so a rep who can't list fleet still sees who's assigned). When
// `withContact` is set, options show the staff phone alongside the name.
function StaffSelect({
  label, value, currentName, options, disabled, onChange, withContact,
}: {
  label: string;
  value: number | null | undefined;
  currentName: string | null | undefined;
  options: FleetStaff[];
  disabled: boolean;
  onChange: (id: number | null) => void;
  withContact?: boolean;
}) {
  return (
    <label className="fld" style={{ marginBottom: 6 }}>
      <span className="fld-l">{label}</span>
      <select className="fld-i" value={value ?? ""} disabled={disabled} onChange={(e) => { const v = e.target.value; onChange(v ? parseInt(v, 10) : null); }}>
        <option value="">— unassigned —</option>
        {value != null && currentName && !options.some((o) => o.id === value) && (
          <option value={value}>{currentName}</option>
        )}
        {options.map((o) => <option key={o.id} value={o.id}>{withContact ? staffLabel(o) : (o.name || `#${o.id}`)}</option>)}
      </select>
    </label>
  );
}

function PhaseBlock({
  kind, projectId, project, photo, drivers, lorries, canWrite, busy, setBusy, patchProject, notify, reloadPhotos,
}: {
  kind: "Setup" | "Dismantle";
  projectId: number;
  project: ProjectDetail["project"];
  photo: PhasePhoto | undefined;
  drivers: FleetStaff[];
  lorries: Lorry[];
  canWrite: boolean;
  busy: boolean;
  setBusy: SetBusy;
  patchProject: (body: Record<string, unknown>) => Promise<boolean>;
  notify: NotifyFn;
  reloadPhotos: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const accent = kind === "Setup" ? "#16695f" : "#a16a2e";
  const phase = kind.toLowerCase() as "setup" | "dismantle";
  const isSetup = kind === "Setup";
  const startAt = isSetup ? project.setup_start_at : project.dismantle_start_at;
  const driverId = isSetup ? project.setup_driver_user_id : project.dismantle_driver_user_id;
  const driverName = isSetup ? project.setup_driver_name : project.dismantle_driver_name;
  const lorryId = isSetup ? project.setup_lorry_id : project.dismantle_lorry_id;
  const lorryPlate = isSetup ? project.setup_lorry_plate : project.dismantle_lorry_plate;
  const startCol = isSetup ? "setup_start_at" : "dismantle_start_at";
  const driverCol = isSetup ? "setup_driver_user_id" : "dismantle_driver_user_id";
  const lorryCol = isSetup ? "setup_lorry_id" : "dismantle_lorry_id";

  const [date, setDate] = useState(isoDatePart(startAt));
  const [time, setTime] = useState(isoTimePart(startAt));

  // Compose date + time → the ISO the backend stores. Only PATCHes when a date
  // is present (time-only is meaningless without a day).
  const saveStart = async (d: string, t: string) => {
    if (!d) return;
    await patchProject({ [startCol]: `${d}T${t || "00:00"}:00` });
  };

  const uploadPhoto = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 50MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const up = await api.putBinary<{ key: string; mime_type: string }>(
        `/api/projects/${projectId}/phase-photos/upload?phase=${phase}&ext=${encodeURIComponent(ext)}`,
        buf,
        file.type || "application/octet-stream",
      );
      await api.post(`/api/projects/${projectId}/phase-photos`, {
        phase,
        r2_key: up.key,
        content_type: up.mime_type,
      });
      void reloadPhotos();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: accent, margin: "0 0 8px" }}>
        {kind}
        {kind === "Dismantle" && (
          <span style={{ color: "#9aa093", fontWeight: 600, textTransform: "none", letterSpacing: 0 }}> · separate from setup</span>
        )}
      </div>
      {canWrite ? (
        <>
          <div style={{ display: "flex", gap: 9, marginBottom: 6 }}>
            <label className="fld" style={{ flex: 1.4 }}>
              <span className="fld-l">{kind} date</span>
              <input className="fld-i" type="date" value={date} disabled={busy} onChange={(e) => { setDate(e.target.value); void saveStart(e.target.value, time); }} />
            </label>
            <label className="fld" style={{ flex: 1 }}>
              <span className="fld-l">Start time</span>
              <input className="fld-i" type="time" value={time} disabled={busy} onChange={(e) => { setTime(e.target.value); void saveStart(date, e.target.value); }} />
            </label>
          </div>
          <StaffSelect label={`${kind} driver & contact`} value={driverId} currentName={driverName} options={drivers} disabled={busy} onChange={(v) => { void patchProject({ [driverCol]: v }); }} withContact />
          <label className="fld" style={{ marginBottom: 6 }}>
            <span className="fld-l">Lorry / vehicle</span>
            <select className="fld-i" value={lorryId ?? ""} disabled={busy} onChange={(e) => { const v = e.target.value; void patchProject({ [lorryCol]: v ? parseInt(v, 10) : null }); }}>
              <option value="">— unassigned —</option>
              {lorryId != null && lorryPlate && !lorries.some((l) => l.id === lorryId) && (
                <option value={lorryId}>{lorryPlate}</option>
              )}
              {lorries.map((l) => <option key={l.id} value={l.id}>{l.plate || `#${l.id}`}{l.is_internal === false ? " (outsource)" : ""}</option>)}
            </select>
          </label>
        </>
      ) : (
        <div className="pgrid2" style={{ marginBottom: 6 }}>
          <div><div className="pkv-l">{kind} date</div><div className="pkv-v">{dOnly(startAt)}</div></div>
          <div><div className="pkv-l">Start time</div><div className="pkv-v">{tOnly(startAt)}</div></div>
          <div><div className="pkv-l">{kind} driver</div><div className="pkv-v">{driverName || "—"}</div></div>
          <div><div className="pkv-l">Lorry / vehicle</div><div className="pkv-v">{lorryPlate || "—"}</div></div>
        </div>
      )}
      <button
        type="button"
        disabled={busy || !canWrite}
        onClick={() => canWrite && fileRef.current?.click()}
        style={{ width: "100%", border: "1px solid #d6d9d2", borderRadius: 11, background: "#fff", display: "flex", alignItems: "center", gap: 10, marginTop: 4, overflow: "hidden", cursor: canWrite ? "pointer" : "default", fontFamily: "inherit", padding: 0, textAlign: "left" }}
      >
        <div className="ph" style={{ width: 64, height: 54, flex: "none" }} />
        <div style={{ padding: "7px 0", minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#11140f" }}>{kind} photo{canWrite ? " · tap to upload" : ""}</div>
          <div style={{ fontSize: 9.5, color: "#9aa093", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{uploaderCredit(photo)}</div>
        </div>
      </button>
      <input ref={fileRef} type="file" accept="image/*,.pdf,.mp4,.mov,.webm" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPhoto(f); }} />
    </>
  );
}

// ── Floor plans & layout + stock transfers ──
// The 3D viewer stays a design placeholder (no plan-image payload). The
// Unfilled / Filled plan tiles are wired to the project's floorplan-category
// attachments: tap opens the plan when one exists, or prompts an upload.
// The Stock Transfer Record is upload-only (matches the design): a stock-out
// record is uploaded via PUT /:id/stock-transfers/upload → POST
// /:id/stock-transfers. Existing rows are listed read-only.
function FloorPlans({
  projectId, stockTransfers, attachments, canWrite, busy, setBusy, notify, reload,
}: {
  projectId: number;
  stockTransfers?: StockTransfer[];
  attachments?: ProjectAttachment[];
  canWrite: boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  reload: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const transfers = stockTransfers ?? [];

  // Unfilled = first floorplan attachment, Filled = second (matches the
  // prototype's two "tap to view" tiles). Opens the stored plan when present.
  const plans = (attachments ?? []).filter((a) => (a.category || "").toLowerCase() === "floorplan");
  const openPlan = async (a: ProjectAttachment | undefined, which: string) => {
    if (!a) {
      await notify({ title: `${which} plan not uploaded`, body: "No floor plan has been uploaded for this project yet.", tone: "info" });
      return;
    }
    const key = pick(a.r2_key, a.r2Key);
    if (!key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${key}`);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      await notify({ title: "Couldn't open plan", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    }
  };

  const uploadTransfer = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 10MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const up = await api.putBinary<{ key: string; mime_type: string }>(
        `/api/projects/${projectId}/stock-transfers/upload?ext=${encodeURIComponent(ext)}`,
        buf,
        file.type || "application/octet-stream",
      );
      await api.post(`/api/projects/${projectId}/stock-transfers`, {
        direction: "out",
        record_r2_key: up.key,
        file_name: file.name,
        mime_type: up.mime_type,
      });
      reload();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <details className="pacc">
      <summary>
        <span className="psec-t">Floor plans &amp; layout</span>
        {transfers.length > 0 && <span style={{ marginLeft: "auto", fontSize: 10, color: "#9aa093" }}>{transfers.length} transfer{transfers.length === 1 ? "" : "s"}</span>}
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        <div style={{ width: "100%", display: "flex", alignItems: "center", gap: 11, background: "#15161a", borderRadius: 12, padding: "13px 14px", marginBottom: 9 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, background: "rgba(216,168,90,.18)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#d8a85a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8l-9-5-9 5v8l9 5Z" /><path d="M3 8l9 5 9-5M12 13v8" /></svg>
          </span>
          <span style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#fff" }}>3D floor plan</span>
            <span style={{ display: "block", fontSize: 10.5, color: "#8c968a" }}>Interactive booth render</span>
          </span>
          <span style={{ color: "#8c968a" }}>›</span>
        </div>

        {/* Unfilled / Filled plan tiles — tap to view the stored floorplan */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
          {([["Unfilled", plans[0], "DRAFT", "#f6efd9", "#6e4d12"], ["Filled", plans[1], "PLACED", "#e2f0e9", "#2f8a5b"]] as const).map(([label, att, badge, badgeBg, badgeCol]) => {
            const key = att ? pick(att.r2_key, att.r2Key) : undefined;
            return (
              <div
                key={label}
                role="button"
                tabIndex={0}
                onClick={() => void openPlan(att, label)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openPlan(att, label); } }}
                style={{ border: "1px solid #d6d9d2", borderRadius: 11, overflow: "hidden", cursor: "pointer" }}
              >
                {att && key && /^image\//.test(pick(att.mime_type, att.mimeType) ?? "")
                  ? <R2Thumb r2Key={key} style={{ width: "100%", height: 80 }} />
                  : <div className="ph" style={{ height: 80 }} />}
                <div style={{ padding: "7px 9px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#11140f" }}>{label} plan</div>
                  <span className="rbadge" style={{ background: att ? badgeBg : "#f0f1ed", color: att ? badgeCol : "#9aa093" }}>{att ? badge : "NONE"}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093", margin: "10px 0 6px" }}>Stock transfer record</div>
        {transfers.length === 0 && <div style={{ fontSize: 12, color: "#9aa093", marginBottom: 8 }}>No stock transfer recorded yet.</div>}
        {transfers.length > 0 && (
          <div style={{ border: "1px solid #e3e6e0", borderRadius: 10, overflow: "hidden", marginBottom: 8 }}>
            {transfers.map((t, i) => {
              const who = pick(t.created_by_name, t.createdByName);
              const when = pick(t.transferred_at, t.transferredAt);
              return (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderTop: i === 0 ? "none" : "1px solid #eceee9", flexWrap: "wrap" }}>
                  <span className="rbadge" style={{ background: "#e2f0e9", color: "#2f8a5b" }}>OUT</span>
                  <span style={{ flex: 1, minWidth: 80, fontSize: 11, color: "#414539" }}>{[who || "—", when ? dm(when) : null].filter(Boolean).join(" · ")}</span>
                </div>
              );
            })}
          </div>
        )}
        {canWrite && (
          <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
            <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,.xlsx" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadTransfer(f); }} />
            <button className="tinybtn" disabled={busy} onClick={() => fileRef.current?.click()}>Upload stock-out record</button>
          </div>
        )}
      </div>
    </details>
  );
}

// ── Finance snapshot ──
function FinancialSnapshot({
  projectId, finance, lines, canLogSale, busy, setBusy, prompt, notify, reload,
}: {
  projectId: number;
  finance: NonNullable<ProjectDetail["finance"]>;
  lines?: FinanceLine[];
  canLogSale: boolean;
  busy: boolean;
  setBusy: SetBusy;
  prompt: PromptFn;
  notify: NotifyFn;
  reload: () => void;
}) {
  const openReceipt = async (line: FinanceLine) => {
    const key = pick(line.r2_key, line.r2Key);
    if (!key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${key}`);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      await notify({ title: "Couldn't open receipt", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    }
  };

  // Quick-log a sale at the project (POST /api/sales/entries { quick_log }).
  // Lands as a draft sales entry; surfaces as a synthetic income line.
  const logSale = async () => {
    const amtStr = await prompt({
      title: "Sale amount (RM)",
      placeholder: "0.00",
      validate: (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? null : "Enter a positive number."; },
    });
    if (amtStr == null) return;
    const ref = await prompt({ title: "Reference no. (optional)", placeholder: "e.g. INV-123" });
    if (ref == null) return;
    const today = new Date().toISOString().slice(0, 10);
    setBusy(true);
    try {
      await api.post(`/api/sales/entries`, {
        project_id: projectId,
        quick_log: true,
        amount: parseFloat(amtStr),
        ref_no: ref.trim() || null,
        occurred_at: today,
      });
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const allLines = lines ?? [];
  const costLines = allLines.filter((l) => (l.kind ?? "").toLowerCase() === "cost");
  const incomeLines = allLines.filter((l) => (l.kind ?? "").toLowerCase() === "income");
  const sales = finance.total_sales ?? 0;
  const cost =
    (finance.rental ?? 0) +
    (finance.contractor_cost ?? 0) +
    (finance.license_fee ?? 0) +
    (finance.misc_cost ?? 0) -
    (finance.deposit_refund ?? 0);
  const net = sales - cost;
  const marginPct = sales > 0 ? (net / sales) * 100 : null;
  const netColor = net >= 0 ? "#2f8a5b" : "#b23a3a";

  return (
    <details className="pacc fin-only" open>
      <summary>
        {/* Title + gating badge — design "P&L (finance)" VERBATIM, plus our
            live net so the collapsed header still carries the headline number. */}
        <span className="psec-t" style={{ color: "#8a4b12" }}>P&amp;L (finance)</span>
        <span className="rbadge" style={{ marginLeft: "auto", background: "#f3ece0", color: "#a16a2e" }}>Owner / Director only</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: netColor, marginLeft: 8 }}>Net RM {rm(net)}</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div style={{ background: "#f4f6f3", borderRadius: 10, padding: 11 }}>
            <div className="pkv-l">Total sales</div>
            <div className="money" style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 3 }}>RM {rm(sales)}</div>
          </div>
          <div style={{ background: "#f4f6f3", borderRadius: 10, padding: 11 }}>
            <div className="pkv-l">Total cost</div>
            <div className="money" style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 3 }}>RM {rm(cost)}</div>
          </div>
          <div style={{ background: "#f4f6f3", borderRadius: 10, padding: 11 }}>
            <div className="pkv-l">Net profit</div>
            <div className="money" style={{ fontSize: 16, fontWeight: 800, color: netColor, marginTop: 3 }}>RM {rm(net)}</div>
          </div>
          <div style={{ background: "#f4f6f3", borderRadius: 10, padding: 11 }}>
            <div className="pkv-l">Margin</div>
            <div className="money" style={{ fontSize: 16, fontWeight: 800, color: netColor, marginTop: 3 }}>{marginPct == null ? "—" : `${marginPct.toFixed(1)}%`}</div>
          </div>
        </div>
        {/* Sales / income lines — quick-log adds a draft sales entry which
            surfaces here as a synthetic income line. Read-only otherwise. */}
        <div style={{ display: "flex", alignItems: "center", margin: "12px 0 6px" }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093" }}>Sales</span>
          {canLogSale && <button className="tinybtn" style={{ marginLeft: "auto", color: "#16695f", borderColor: "#bcdcd7" }} disabled={busy} onClick={logSale}>+ Log sale</button>}
        </div>
        {incomeLines.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9aa093" }}>No sales recorded.</div>
        ) : (
          <div style={{ border: "1px solid #eceee9", borderRadius: 10, overflow: "hidden" }}>
            {incomeLines.map((line, i) => (
              <div key={`${line.source ?? "l"}-${line.id}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderTop: i === 0 ? "none" : "1px solid #eceee9", flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 90, fontSize: 12, color: "#414539" }}>{line.description || humanize(line.category || "sales")}</span>
                <span className="money" style={{ fontSize: 12, fontWeight: 700, color: "#2f8a5b" }}>RM {rm(line.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Cost ledger — read-only snapshot. A stored receipt opens in a new tab. */}
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093", margin: "12px 0 6px" }}>Cost lines</div>
        {costLines.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9aa093" }}>No cost lines yet.</div>
        ) : (
          <div style={{ border: "1px solid #eceee9", borderRadius: 10, overflow: "hidden" }}>
            {costLines.map((line, i) => {
              const auto = !!pick(line.auto_source, line.autoSource);
              const receiptKey = pick(line.r2_key, line.r2Key);
              return (
                <div key={line.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderTop: i === 0 ? "none" : "1px solid #eceee9", flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 90, fontSize: 12, color: "#414539" }}>
                    {line.description || humanize(line.category || "—")}
                    {auto && <span style={{ marginLeft: 5, fontSize: 9, color: "#9aa093" }}>auto</span>}
                  </span>
                  <span className="money" style={{ fontSize: 12, fontWeight: 700 }}>RM {rm(line.amount)}</span>
                  {receiptKey && <button className="tinybtn" disabled={busy} onClick={() => openReceipt(line)}>Receipt</button>}
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 12px", borderTop: "1px solid #eceee9", fontSize: 12, fontWeight: 700, color: "#11140f", background: "#f4f6f3" }}>
              <span>Net profit{marginPct != null ? ` (${marginPct.toFixed(1)}%)` : ""}</span>
              <span className="money" style={{ color: netColor }}>RM {rm(net)}</span>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

// R2-backed thumbnail. <img src> can't carry the bearer, so fetch as a blob
// URL (api.fetchBlobUrl) and revoke on unmount. r2Key is streamed from the
// project attachments endpoint (/api/projects/attachments/:key).
function R2Thumb({ r2Key, style }: { r2Key: string; style?: React.CSSProperties }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    api.fetchBlobUrl(`/api/projects/attachments/${r2Key}`)
      .then((u) => { if (live) { made = u; setUrl(u); } else URL.revokeObjectURL(u); })
      .catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [r2Key]);
  if (!url) return <div className="ph" style={style} />;
  return <img src={url} alt="" style={{ ...style, objectFit: "cover", display: "block" }} />;
}

// ── Small building blocks ──
// List meta pill (spec project-list: branding / venue chips under the title).
function ListChip({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: "#5c6156", background: "#f0f1ed", border: "1px solid var(--line)", padding: "3px 8px", borderRadius: 7 }}>
      {children}
    </span>
  );
}

function CostRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 12px", borderTop: "1px solid #eceee9", fontSize: 12, color: "#414539" }}>
      <span>{label}</span>
      <span className="money">RM {rm(value)}</span>
    </div>
  );
}

function StatusPill({ status, dark }: { status: string | null; dark?: boolean }) {
  const s = (status ?? "").toLowerCase();
  const map: Record<string, [string, string]> = {
    confirmed: ["#e1f0e7", "#1c6b45"],
    pending: ["#f6efd9", "#6e4d12"],
    cancelled: ["#f7e7e5", "#a13a34"],
  };
  const [bg, fg] = map[s] ?? ["#eef0ec", "#767b6e"];
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : "—";
  return (
    <span className="spill" style={{
      background: dark ? "rgba(216,168,90,.16)" : bg,
      color: dark ? "#d8a85a" : fg,
      border: dark ? "1px solid rgba(216,168,90,.4)" : "none",
    }}>{label}</span>
  );
}

function PaymentBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const map: Record<string, [string, string]> = {
    fully_paid: ["#e2f0e9", "#2f8a5b"],
    paid: ["#e2f0e9", "#2f8a5b"],
    pending: ["#f6efd9", "#6e4d12"],
    unpaid: ["#f7e7e5", "#a13a34"],
    na: ["#f4f6f3", "#767b6e"],
  };
  const [bg, fg] = map[s] ?? ["#f4f6f3", "#767b6e"];
  return <span className="rbadge" style={{ marginLeft: "auto", background: bg, color: fg }}>{humanize(status).toUpperCase()}</span>;
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
