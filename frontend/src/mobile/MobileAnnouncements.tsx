import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { MobileVirtualList } from "./MobileVirtualList";
import { useAuth } from "../auth/AuthContext";
import { isSalesDirectorUser } from "../auth/salesAccess";
import { formatDate } from "../lib/utils";
import "./mobile.css";

// ---------------------------------------------------------------------------
// Mobile Announcements — list + detail + compose, wired to /api/announcements.
// Presentation is ported VERBATIM from the owner's UPDATED mobile design (Houzs
// Mobile.html #m-ann / #ann-detail / #ann-new + renderAnn / annAttBig /
// annReceipts / annAck) using the .hz-m design classes (.hdr .ey .card .spill
// .tinybtn .btn .actbar .fld .fld-l .fld-i).
//
// vs the previous version: NO cover image (dropped), attachments render INLINE
// (photo grid / video / PDF rows), the audience is HIDDEN from recipients,
// publishers see READ RECEIPTS (GET /:id/acks), and the detail has an explicit
// sticky "Got it — mark as read" acknowledgement bar wired to POST /:id/ack.
//
// The banner GET (/api/announcements/banner) returns the notices THIS user is
// allowed to see plus the ids they've already acked; we use it for the list so
// non-admins see their own feed and honest unread dots. Compose is gated on
// announcements.write and hits POST /api/announcements. No emoji.
// ---------------------------------------------------------------------------

type Attachment = { r2Key: string; name: string; mime: string; size?: number };

// Rich-media layout hint (mig 0139). Optional keys; absent = derive a default
// from the attachment count (legacy rows render unchanged).
type PhotoLayout = "1" | "2" | "3" | "4";
type VideoLayout = "1x1" | "1x2";
type MediaLayout = { photo?: PhotoLayout; video?: VideoLayout } | null;

type Announcement = {
  id: string;
  title: string;
  body: string;
  isActive: boolean;
  createdAt: string | null;
  createdBy: number | null;
  createdByName?: string | null;
  remindedAt: string | null;
  updatedAt: string | null;
  attachments: Attachment[];
  mediaLayout?: MediaLayout;
  targetType: string;
  targetDeptIds?: number[];
  targetPositionIds?: number[];
  targetUserIds?: number[];
  targetCompanyIds?: number[];
  category: string;
  source?: string | null;
};

// Multi-company: the company-target selector + row chip only appear when
// /api/companies returns MORE THAN ONE company (mirrors the desktop rule).
type Company = { id: number; code: string; name: string };

// Audience-picker lookups. Dept + position come from the same core endpoints the
// desktop Announcements composer uses (/api/departments, /api/positions);
// user-level targeting reuses /api/users (gated by users.read). Every field
// optional so a leaner backend never crashes the picker.
type Dept = { id: number; name: string };
type Position = { id: number; name: string; department_name?: string | null };
type UserRow = { id: number; name: string | null; email: string; status?: string | null };

type BannerResponse = {
  success?: boolean;
  data?: Announcement[];
  ackedIds?: string[];
};

// Read-receipt roster from GET /:id/acks — shown to publishers only.
type AcksResponse = {
  success?: boolean;
  data?: {
    total: number;
    ackedCount: number;
    acked: Array<{ id: number; name: string; email: string; ackedAt: string | null }>;
    pending: Array<{ id: number; name: string; email: string }>;
  };
};

// Category chip colours mirror the design's ANN_CAT map. The backend stores an
// enum; the design's labels (HR/Operations/Sales/Policy/Management) are folded
// onto our enum plus keyed by the raw label so custom categories still colour.
const CATEGORY_LABEL: Record<string, string> = {
  GENERAL: "General",
  WARNING: "Warning",
  SOP: "SOP",
  LEARNING: "Learning",
};

const CAT_COLOR: Record<string, string> = {
  General: "#475569",
  HR: "#7a5c86",
  Operations: "#0e7490",
  Sales: "#15803d",
  Policy: "#b45309",
  Management: "#a16a2e",
  Warning: "#b45309",
  SOP: "#0e7490",
  Learning: "#7a5c86",
};

const catLabel = (a: Announcement) => CATEGORY_LABEL[a.category] ?? a.category ?? "General";
const catColor = (a: Announcement) => CAT_COLOR[catLabel(a)] ?? "#475569";

// Numeric DD/MM/YYYY (owner standard) via the shared app formatter.
const dm = (d: string | null | undefined) => formatDate(d);

const byLine = (a: Announcement) => a.createdByName?.trim() || "Management";

const isImage = (att: Attachment) => (att.mime || "").startsWith("image/");
const isVideo = (att: Attachment) => (att.mime || "").startsWith("video/");

// Layout-hint helpers (mig 0139). Mirror the desktop AnnouncementMedia mapping
// so a notice lays out identically on both platforms.
function photoCols(layout: PhotoLayout): number {
  return layout === "4" ? 2 : Number(layout);
}
function defaultPhotoLayout(n: number): PhotoLayout {
  if (n <= 1) return "1";
  if (n === 2) return "2";
  if (n === 3) return "3";
  return "4";
}
function videoAspect(layout: VideoLayout): string {
  return layout === "1x2" ? "1 / 2" : "1 / 1";
}

const fmtSize = (n?: number) => {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// annCatChip() from the design — the pill badge, colour-tinted by category.
function CatChip({ ann }: { ann: Announcement }) {
  const col = catColor(ann);
  return (
    <span className="spill" style={{ background: `${col}1f`, color: col }}>
      {catLabel(ann)}
    </span>
  );
}

// Company-scope label: empty target (or covering every company) = "Both"/"All";
// a subset lists the codes. Mirrors the desktop companyScopeLabel.
function companyScopeLabel(ids: number[] | undefined, companies: Company[]): string {
  const list = ids ?? [];
  if (companies.length === 0) return "";
  if (list.length === 0 || list.length >= companies.length) {
    return companies.length === 2 ? "Both" : "All";
  }
  return list.map((id) => companies.find((co) => co.id === id)?.code ?? `#${id}`).join(" / ");
}

// A neutral company-scope chip (multi-company only), styled like .spill.
function CompanyChip({ ann, companies }: { ann: Announcement; companies: Company[] }) {
  if (companies.length <= 1) return null;
  return (
    <span className="spill" style={{ background: "#eef1ec", color: "#556052" }}>
      {companyScopeLabel(ann.targetCompanyIds, companies)}
    </span>
  );
}

// A photo/video thumb streamed from R2. <img src> can't carry the bearer, so we
// fetch it as a blob URL (api.fetchBlobUrl) and revoke on unmount. Falls back to
// the design's .ph placeholder if there's no image / the fetch fails.
function MediaThumb({ ann, att, style }: { ann: Announcement; att: Attachment; style: React.CSSProperties }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    const path = `/api/announcements/${encodeURIComponent(ann.id)}/attachments/${att.r2Key}`;
    api
      .fetchBlobUrl(path)
      .then((u) => {
        if (!live) {
          URL.revokeObjectURL(u);
          return;
        }
        made = u;
        setUrl(u);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [ann.id, att.r2Key]);

  if (url && !failed) {
    return <img src={url} alt="" style={{ ...style, objectFit: "cover", display: "block" }} />;
  }
  return <div className="ph" style={style} />;
}

// annDl() — stream the attachment as a blob and trigger a browser download.
async function download(ann: Announcement, att: Attachment) {
  try {
    const u = await api.fetchBlobUrl(
      `/api/announcements/${encodeURIComponent(ann.id)}/attachments/${att.r2Key}`,
    );
    const link = document.createElement("a");
    link.href = u;
    link.download = att.name || "attachment";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  } catch {
    /* silent — the row stays visible, tap to retry. */
  }
}

// annAttBig() — inline attachments: a photo grid, then video blocks, then PDF /
// file rows. Nothing renders if there are no attachments.
function Attachments({ ann }: { ann: Announcement }) {
  const atts = ann.attachments ?? [];
  if (!atts.length) return null;
  const photos = atts.filter(isImage);
  const rest = atts.filter((a) => !isImage(a));

  // Honour the author's layout hint; fall back to a count-derived default so
  // legacy (NULL media_layout) notices render as before.
  const photoLayout = ann.mediaLayout?.photo ?? defaultPhotoLayout(photos.length);
  const cols = photoCols(photoLayout);
  const videoLayout = ann.mediaLayout?.video ?? "1x1";
  const photoAspect = cols === 1 ? "16 / 9" : "1 / 1";

  return (
    <div>
      <div className="ey" style={{ color: "#767b6e", margin: "0 2px 8px" }}>Attachments</div>
      {photos.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 7, marginBottom: 8 }}>
          {photos.map((p) => (
            <MediaThumb key={p.r2Key} ann={ann} att={p} style={{ width: "100%", aspectRatio: photoAspect, borderRadius: 9 }} />
          ))}
        </div>
      )}
      {rest.map((a) =>
        isVideo(a) ? (
          <div key={a.r2Key} style={{ position: "relative", borderRadius: 11, overflow: "hidden", marginBottom: 8 }}>
            <MediaThumb ann={ann} att={a} style={{ width: "100%", aspectRatio: videoAspect(videoLayout), maxHeight: 380, borderRadius: 11 }} />
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7Z" /></svg>
              </span>
            </span>
            <span style={{ position: "absolute", bottom: 8, left: 10, fontSize: 10.5, fontWeight: 600, color: "#fff" }}>
              {a.name}{fmtSize(a.size) ? ` · ${fmtSize(a.size)}` : ""}
            </span>
          </div>
        ) : (
          <div key={a.r2Key} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid #e3e6e0", borderRadius: 11, padding: "10px 12px", marginBottom: 8 }}>
            <span style={{ width: 34, height: 34, flex: "none", borderRadius: 8, background: "#f8eaea", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b23a3a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" /></svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
              <div style={{ fontSize: 10.5, color: "#9aa093" }}>
                {(a.mime || "").includes("pdf") ? "PDF" : "File"}{fmtSize(a.size) ? ` · ${fmtSize(a.size)}` : ""}
              </div>
            </div>
            <span onClick={() => download(ann, a)} style={{ fontSize: 11, fontWeight: 700, color: "#a16a2e", cursor: "pointer" }}>Download</span>
          </div>
        ),
      )}
    </div>
  );
}

// annReceipts() — publisher-only read receipts from GET /:id/acks. Progress bar
// + roster (Read / Not read) + a Remind button (POST /:id/remind). Hides itself
// gracefully if the roster can't be loaded. Never renders NaN.
function Receipts({ ann }: { ann: Announcement }) {
  const { data } = useQuery({
    queryKey: ["announcement-acks", ann.id],
    queryFn: () => api.get<AcksResponse>(`/api/announcements/${encodeURIComponent(ann.id)}/acks`),
    staleTime: 15_000,
  });
  const [reminded, setReminded] = useState(false);

  const r = data?.data;
  if (!r) return null;
  const total = r.total ?? 0;
  const read = r.ackedCount ?? 0;
  const pct = total > 0 ? Math.round((read / total) * 100) : 0;
  const rows = [
    ...r.acked.map((p) => ({ id: `a-${p.id}`, name: p.name || p.email || "—", read: true })),
    ...r.pending.map((p) => ({ id: `p-${p.id}`, name: p.name || p.email || "—", read: false })),
  ];
  const unread = Math.max(total - read, 0);

  const remind = () => {
    api.post(`/api/announcements/${encodeURIComponent(ann.id)}/remind`).catch(() => {});
    setReminded(true);
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="ey" style={{ color: "#767b6e", margin: "0 2px 8px" }}>Read receipts</div>
      <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "12px 13px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f" }}>Read {read} / {total}</span>
          <span style={{ fontSize: 11, color: "#9aa093" }}>{pct}%</span>
        </div>
        <div style={{ height: 6, borderRadius: 6, background: "#e3e6e0", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "#2f8a5b", borderRadius: 6 }} />
        </div>
        {rows.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderTop: "1px solid #eceee9" }}>
            <span style={{ flex: 1, fontSize: 12.5, color: "#11140f" }}>{p.name}</span>
            {p.read ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "#2f8a5b" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2f8a5b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                Read
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "#9aa093" }}>Not read</span>
            )}
          </div>
        ))}
        {unread > 0 && (
          <button
            onClick={remind}
            disabled={reminded}
            className="tinybtn"
            style={{ marginTop: 10, width: "100%", padding: 9, opacity: reminded ? 0.6 : 1, cursor: reminded ? "default" : "pointer" }}
          >
            {reminded ? "Reminder sent" : `Remind ${unread} who haven't read`}
          </button>
        )}
      </div>
    </div>
  );
}

const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "GENERAL", label: "General" },
  { value: "WARNING", label: "Warning" },
  { value: "SOP", label: "SOP" },
  { value: "LEARNING", label: "Learning" },
];

// Which id-bucket a notice targets. ALL = everyone (back-compat default); the
// other three map 1:1 to the backend's targetDeptIds / targetPositionIds /
// targetUserIds. Mirrors the desktop composer's Bucket.
type Bucket = "ALL" | "DEPT" | "POSITION" | "USER";
const BUCKETS: Array<{ value: Bucket; label: string }> = [
  { value: "ALL", label: "All staff" },
  { value: "DEPT", label: "Departments" },
  { value: "POSITION", label: "Positions" },
  { value: "USER", label: "People" },
];

export function MobileAnnouncements({ onBack }: { onBack?: () => void }) {
  const { can, user } = useAuth();
  // A Sales Director may compose (owner rule 2026-07-15) even without the
  // announcements.* permission — code-keyed off the org chart, mirroring the
  // backend requirePermissionOrSalesDirector admittance. `salesDirOnly` =
  // admitted purely as a Sales Director: their composer is constrained to the
  // Sales department / a specific salesperson (backend enforces).
  const isSalesDir = isSalesDirectorUser(user);
  const canCreate = can("announcements.write") || isSalesDir;
  const salesDirOnly = isSalesDir && !can("announcements.write");
  const qc = useQueryClient();

  const [view, setView] = useState<"list" | "detail" | "compose">("list");
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-announcements"],
    queryFn: () => api.get<BannerResponse>("/api/announcements/banner"),
    staleTime: 30_000,
  });

  // Audience-picker lookups — fetched only for publishers (they gate the
  // compose/edit UI). retry:false so a 403 on /api/users just yields [] and the
  // People bucket hides itself, rather than crashing or spamming retries.
  const deptsQ = useQuery({
    queryKey: ["mobile-ann-depts"],
    queryFn: () => api.get<{ departments: Dept[] }>("/api/departments"),
    enabled: canCreate,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const positionsQ = useQuery({
    queryKey: ["mobile-ann-positions"],
    queryFn: () => api.get<{ positions: Position[] }>("/api/positions"),
    enabled: canCreate,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const usersQ = useQuery({
    queryKey: ["mobile-ann-users"],
    queryFn: () => api.get<{ users: UserRow[] }>("/api/users"),
    enabled: canCreate,
    staleTime: 60_000,
    retry: false,
  });
  // Companies drive the compose selector + the list/detail chip — fetched for
  // everyone (cheap, cached). Empty/one company hides both controls.
  const companiesQ = useQuery({
    queryKey: ["mobile-ann-companies"],
    queryFn: () => api.get<{ companies: Company[] }>("/api/companies"),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const companies = companiesQ.data?.companies ?? [];
  const lookups = {
    depts: deptsQ.data?.departments ?? [],
    positions: positionsQ.data?.positions ?? [],
    users: (usersQ.data?.users ?? []).filter((u) => (u.status ?? "active") === "active"),
    usersDenied: !!usersQ.error,
    companies,
  };

  const list = data?.data ?? [];
  // acked ids from the banner; locally-acked ids clear the dot without a refetch.
  const [localAcked, setLocalAcked] = useState<Set<string>>(new Set());
  const ackedIds = useMemo(() => {
    const s = new Set<string>(data?.ackedIds ?? []);
    for (const id of localAcked) s.add(id);
    return s;
  }, [data?.ackedIds, localAcked]);

  const open = list.find((a) => a.id === openId) ?? null;

  const markAcked = (id: string) => {
    setLocalAcked((prev) => new Set(prev).add(id));
    qc.invalidateQueries({ queryKey: ["announcement-acks", id] });
  };

  if (view === "compose" && canCreate) {
    return (
      <Compose
        lookups={lookups}
        salesDirOnly={salesDirOnly}
        onClose={() => setView("list")}
        onPublished={() => {
          qc.invalidateQueries({ queryKey: ["mobile-announcements"] });
          setView("list");
        }}
      />
    );
  }

  if (view === "detail" && open) {
    return (
      <Detail
        ann={open}
        companies={companies}
        // Read-receipts for any human notice this user can compose (matches the
        // desktop: a dept/person-targeted notice has a meaningful roster too). A
        // source='scan' per-user notice is excluded — it's meant for one person,
        // so "who read it" is meaningless. The Receipts panel hides itself when
        // the roster can't be loaded (e.g. a Sales Director opening a notice they
        // didn't author — the backend 404s /:id/acks for non-owners).
        canReceipts={canCreate && open.source !== "scan"}
        acked={ackedIds.has(open.id)}
        onAcked={() => markAcked(open.id)}
        onBack={() => setView("list")}
      />
    );
  }

  // Designer list layout (#m-ann): a header row with a hamburger "Menu" (returns
  // to the module menu via onBack) on the left and the "New" compose button on
  // the right, then the "Announcements" title below. Cards (renderAnn) are
  // buttons: a category-tinted speaker-icon tile, the title + green unread dot,
  // a category chip + byline (publisher · date), and an attachment count. The
  // category chip + attachment count come from the live wiring.
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
          {onBack ? (
            <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#16695f", cursor: "pointer" }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
              Menu
            </span>
          ) : <span />}
          {canCreate && (
            <button onClick={() => setView("compose")} className="tinybtn" style={{ background: "var(--brand)", borderColor: "var(--brand)", color: "#fff", display: "flex", alignItems: "center", gap: 5 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
              New
            </button>
          )}
        </div>
        <div className="scr-title">Announcements</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 120 }}>
        {isLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load announcements. Pull to retry.</div>}
        {!isLoading && !error && (
          <>
            {list.length > 0 && (
              <MobileVirtualList
                items={list}
                getKey={(a) => a.id}
                estimateHeight={72}
                gap={9}
                renderItem={(a) => {
              const unread = !ackedIds.has(a.id);
              const na = (a.attachments ?? []).length;
              const col = catColor(a);
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    setOpenId(a.id);
                    setView("detail");
                  }}
                  style={{ display: "flex", alignItems: "flex-start", gap: 11, width: "100%", textAlign: "left", background: "#fff", border: `1px solid ${unread ? "#bcdcd7" : "#e3e6e0"}`, borderRadius: 13, padding: "12px 13px", cursor: "pointer", fontFamily: "inherit" }}
                >
                  <span style={{ width: 36, height: 36, flex: "none", borderRadius: 10, background: `${col}1f`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={col} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M16 8a4 4 0 0 1 0 8" /></svg>
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: unread ? 800 : 700, color: "#11140f", lineHeight: 1.25 }}>{a.title}</span>
                      {unread && <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "#16695f" }} />}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5, flexWrap: "wrap" }}>
                      <CatChip ann={a} />
                      <CompanyChip ann={a} companies={companies} />
                      <span style={{ fontSize: 11, color: "#767b6e" }}>{byLine(a)} · {dm(a.createdAt)}</span>
                    </span>
                    {na > 0 && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6, fontSize: 10.5, color: "#9aa093" }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8 12 17a4 4 0 0 1-6-6l9-9a3 3 0 0 1 4 4l-9 9" /></svg>
                        {na} attachment{na > 1 ? "s" : ""}
                      </span>
                    )}
                  </span>
                </button>
              );
                }}
              />
            )}
            {!list.length && (
              <div className="empty">
                <div className="empty-t">No announcements yet</div>
                <div className="empty-s">Notices from HQ will appear here.</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Detail({
  ann,
  companies,
  canReceipts,
  acked,
  onAcked,
  onBack,
}: {
  ann: Announcement;
  companies: Company[];
  canReceipts: boolean;
  acked: boolean;
  onAcked: () => void;
  onBack: () => void;
}) {
  const [localAck, setLocalAck] = useState(acked);
  const [acking, setAcking] = useState(false);
  const isAcked = acked || localAck;

  const ack = async () => {
    if (isAcked || acking) return;
    setAcking(true);
    try {
      await api.post(`/api/announcements/${encodeURIComponent(ann.id)}/ack`);
    } catch {
      /* best-effort; still reflect the tap so the user isn't stuck. */
    }
    setLocalAck(true);
    setAcking(false);
    onAcked();
  };

  // Designer detail layout (#ann-detail): the header holds ONLY the back link;
  // the category chip + date, title, byline ("Posted by …") and body all render
  // in the scroll body (body not boxed in a card), then inline attachments,
  // publisher-only read receipts, and a sticky "Got it" ack bar.
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center" }}>
          <button onClick={onBack} className="back">
            <span className="chev">‹</span> Announcements
          </button>
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        <div id="ann-d-meta" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
          <CatChip ann={ann} />
          <CompanyChip ann={ann} companies={companies} />
          <span style={{ fontSize: 11, color: "#9aa093", alignSelf: "center" }}>{dm(ann.createdAt)}</span>
        </div>
        <div id="ann-d-title" style={{ fontSize: 21, fontWeight: 800, color: "#11140f", lineHeight: 1.25 }}>{ann.title}</div>
        <div id="ann-d-by" style={{ fontSize: 11.5, color: "#767b6e", marginTop: 6 }}>Posted by {byLine(ann)}</div>
        <div id="ann-d-body" style={{ fontSize: 13.5, lineHeight: 1.7, color: "#414539", marginTop: 14, whiteSpace: "pre-wrap" }}>{ann.body}</div>
        <div id="ann-d-atts" style={{ marginTop: 16 }}>
          <Attachments ann={ann} />
        </div>
        {canReceipts && (
          <div id="ann-d-receipts" style={{ marginTop: 18 }}>
            <Receipts ann={ann} />
          </div>
        )}
      </div>

      <footer className="actbar" id="ann-d-ackbar">
        {isAcked ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "var(--green)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            You acknowledged this
          </div>
        ) : (
          <button onClick={ack} disabled={acking} className="btn" style={{ cursor: acking ? "default" : "pointer", opacity: acking ? 0.6 : 1 }}>
            {acking ? "Marking…" : "Got it — mark as read"}
          </button>
        )}
      </footer>
    </div>
  );
}

type Lookups = { depts: Dept[]; positions: Position[]; users: UserRow[]; usersDenied: boolean; companies: Company[] };

// Compose (create) an announcement. Audience targeting is real: dept +
// position always available; People (user ids) only when /api/users is readable.
function Compose({
  lookups,
  salesDirOnly,
  onClose,
  onPublished,
}: {
  lookups: Lookups;
  /** Composer opened by a Sales-Director-only caller: audience is constrained
   *  to the whole Sales department OR a specific salesperson in it (owner rule).
   *  The dept / user lookups are already server-scoped to their department. */
  salesDirOnly: boolean;
  onClose: () => void;
  onPublished: () => void;
}) {
  const { user } = useAuth();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(CATEGORY_OPTIONS[0].value);
  const [bucket, setBucket] = useState<Bucket>(salesDirOnly ? "DEPT" : "ALL");
  // Company target: "ALL" = every company (Both — sends no target, NULL = all);
  // a company id = that company only. Default "ALL". Only shown when >1 company.
  const [companyPick, setCompanyPick] = useState<"ALL" | number>("ALL");
  const [selDepts, setSelDepts] = useState<Set<number>>(new Set());
  const [selPositions, setSelPositions] = useState<Set<number>>(new Set());
  const [selUsers, setSelUsers] = useState<Set<number>>(new Set());
  const [userSearch, setUserSearch] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // Rich-media layout hint (mig 0139). "" photo = auto (derive from count);
  // video defaults to a 1x1 square. Only surfaced when the media is attached.
  const [photoLayout, setPhotoLayout] = useState<PhotoLayout | "">("");
  const [videoLayout, setVideoLayout] = useState<VideoLayout>("1x1");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hasPhotos = files.some((f) => (f.type || "").startsWith("image/"));
  const hasVideos = files.some((f) => (f.type || "").startsWith("video/"));

  const addFiles = (picked: FileList | null) => {
    if (!picked || !picked.length) return;
    setFiles((prev) => [...prev, ...Array.from(picked)]);
  };
  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const toggle = (set: Set<number>, id: number): Set<number> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return lookups.users;
    return lookups.users.filter(
      (u) => (u.name ?? "").toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q),
    );
  }, [lookups.users, userSearch]);

  // Sales Director: default the "Sales Department" bucket to their own
  // department (the lookups already return only it), so posting with no manual
  // pick still targets the whole Sales dept + satisfies the DEPT validation.
  // Seeded once so a later deselect isn't fought.
  const seededDeptRef = useRef(false);
  useEffect(() => {
    if (
      salesDirOnly &&
      !seededDeptRef.current &&
      bucket === "DEPT" &&
      lookups.depts.length > 0
    ) {
      seededDeptRef.current = true;
      setSelDepts(new Set(lookups.depts.map((d) => d.id)));
    }
  }, [salesDirOnly, bucket, lookups.depts]);

  const publish = async () => {
    const t = title.trim();
    if (!t) {
      setErr("Title is required.");
      return;
    }
    if (bucket === "DEPT" && selDepts.size === 0) { setErr("Pick at least one department, or choose All staff."); return; }
    if (bucket === "POSITION" && selPositions.size === 0) { setErr("Pick at least one position, or choose All staff."); return; }
    if (bucket === "USER" && selUsers.size === 0) { setErr("Pick at least one person, or choose All staff."); return; }
    setErr(null);
    setSaving(true);
    try {
      // Two-step upload manifest: PUT each file to the 'compose' scope, collect
      // {r2Key, mime} entries. A failed upload is skipped rather than blocking.
      const uploaded: Attachment[] = [];
      for (const f of files) {
        const ext = (f.name.split(".").pop() || "bin").toLowerCase();
        try {
          const manifest = await api.putBinary<{ r2Key: string; mime: string; size?: number }>(
            `/api/announcements/compose/attachments/upload?ext=${encodeURIComponent(ext)}`,
            f,
            f.type || "application/octet-stream",
          );
          if (manifest?.r2Key) {
            uploaded.push({ r2Key: manifest.r2Key, name: f.name, mime: manifest.mime, size: manifest.size });
          }
        } catch {
          /* skip this file; publish the rest. */
        }
      }

      // Real audience targeting — one bucket at a time (mirrors desktop). ALL
      // sends no target arrays (backend derives ALL_USERS). Empty arrays on a
      // non-selected bucket keep the other buckets from being wiped on edit.
      const payload: Record<string, unknown> = {
        title: t,
        body: body.trim(),
        category,
      };
      if (bucket === "DEPT") payload.targetDeptIds = Array.from(selDepts);
      if (bucket === "POSITION") payload.targetPositionIds = Array.from(selPositions);
      if (bucket === "USER") payload.targetUserIds = Array.from(selUsers);
      // Company target: a single company sends [id]; "Both"/ALL omits the field
      // (backend stores NULL = all companies).
      if (companyPick !== "ALL") payload.targetCompanyIds = [companyPick];
      payload.attachments = uploaded;
      // Media layout — only hints for media actually uploaded. Empty photo pick
      // stays absent so the renderer derives a count default.
      const upPhotos = uploaded.some((a) => (a.mime || "").startsWith("image/"));
      const upVideos = uploaded.some((a) => (a.mime || "").startsWith("video/"));
      const mediaLayout: { photo?: PhotoLayout; video?: VideoLayout } = {};
      if (upPhotos && photoLayout) mediaLayout.photo = photoLayout;
      if (upVideos) mediaLayout.video = videoLayout;
      if (mediaLayout.photo || mediaLayout.video) payload.mediaLayout = mediaLayout;
      await api.post("/api/announcements", payload);
      onPublished();
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Couldn't save. Try again.");
      setSaving(false);
    }
  };

  const poster = user?.name?.trim() || "your account";
  // Sales Director: only two audiences — the whole Sales department, or a
  // specific salesperson in it. Everyone else keeps the full bucket set.
  const baseBuckets: Array<{ value: Bucket; label: string }> = salesDirOnly
    ? [
        { value: "DEPT", label: "Sales Department" },
        { value: "USER", label: "Specific salesperson" },
      ]
    : BUCKETS;
  // People bucket only offered when the directory is readable.
  const buckets = lookups.usersDenied
    ? baseBuckets.filter((b) => b.value !== "USER")
    : baseBuckets;
  const companyOptions: Array<["ALL" | number, string]> = [
    ["ALL", "Both"],
    ...lookups.companies.map((co) => [co.id, co.name] as ["ALL" | number, string]),
  ];

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <div className="eyebrow">Compose</div>
            <div className="scr-title">New announcement</div>
          </div>
          <span onClick={onClose} style={{ fontSize: 24, color: "var(--mut)", cursor: "pointer", lineHeight: 1 }}>×</span>
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "#f3ece0", border: "1px solid #e8dcc5", borderRadius: 11, padding: "10px 11px", marginBottom: 14 }}>
          <svg width="15" height="15" style={{ flex: "none", marginTop: 1 }} viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z" /></svg>
          <div style={{ fontSize: 11, color: "#5a3a14", lineHeight: 1.5 }}>
            <b>Publishing rights:</b> Management, HR &amp; department leads. You're posting as <b>{poster}</b>.
          </div>
        </div>

        <label className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Category</span>
          <select className="fld-i" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        {/* Company target — only when more than one company exists. Hidden for
            a Sales Director (they post within their own department only). */}
        {lookups.companies.length > 1 && !salesDirOnly && (
          <>
            <div className="fld-l" style={{ margin: "0 2px 7px" }}>Company</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              {companyOptions.map(([key, label]) => {
                const on = companyPick === key;
                return (
                  <button
                    key={String(key)}
                    onClick={() => setCompanyPick(key)}
                    className="tinybtn"
                    style={{ padding: "7px 13px", background: on ? "var(--brand)" : "#fff", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Audience targeting — bucket selector + the matching id picker. */}
        <div className="fld-l" style={{ margin: "0 2px 7px" }}>Send to</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
          {buckets.map((b) => {
            const on = bucket === b.value;
            return (
              <button
                key={b.value}
                onClick={() => setBucket(b.value)}
                className="tinybtn"
                style={{ padding: "7px 13px", background: on ? "var(--brand)" : "#fff", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        {bucket === "DEPT" && (
          <PickerBox empty={lookups.depts.length === 0 ? "No departments" : null}>
            {lookups.depts.map((d) => (
              <CheckRow key={d.id} label={d.name} checked={selDepts.has(d.id)} onToggle={() => setSelDepts((s) => toggle(s, d.id))} />
            ))}
          </PickerBox>
        )}
        {bucket === "POSITION" && (
          <PickerBox empty={lookups.positions.length === 0 ? "No positions" : null}>
            {lookups.positions.map((p) => (
              <CheckRow
                key={p.id}
                label={p.name}
                sub={p.department_name ?? undefined}
                checked={selPositions.has(p.id)}
                onToggle={() => setSelPositions((s) => toggle(s, p.id))}
              />
            ))}
          </PickerBox>
        )}
        {bucket === "USER" && (
          <>
            <input
              className="fld-i"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Search people…"
              style={{ marginBottom: 8 }}
            />
            <PickerBox empty={filteredUsers.length === 0 ? "No people" : null}>
              {filteredUsers.map((u) => (
                <CheckRow
                  key={u.id}
                  label={u.name || u.email.split("@")[0]}
                  sub={u.email}
                  checked={selUsers.has(u.id)}
                  onToggle={() => setSelUsers((s) => toggle(s, u.id))}
                />
              ))}
            </PickerBox>
          </>
        )}
        <div style={{ fontSize: 10.5, color: "#9aa093", margin: "8px 2px 12px" }}>
          {bucket === "ALL"
            ? "Everyone sees this announcement."
            : "Only the people you pick see it — the audience isn't shown to recipients."}
        </div>

        <label className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Title</span>
          <input className="fld-i" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Announcement title" maxLength={200} />
        </label>
        <label className="fld" style={{ marginBottom: 12 }}>
          <span className="fld-l">Body</span>
          <textarea className="fld-i" value={body} onChange={(e) => setBody(e.target.value)} rows={6} style={{ resize: "none" }} placeholder="Write the announcement…" />
        </label>

        <div className="fld-l" style={{ margin: "6px 0 7px" }}>Attachments</div>
        <div style={{ display: "flex", gap: 9 }}>
          <label className="tinybtn" style={{ flex: 1, padding: 11, textAlign: "center", cursor: "pointer" }}>
            + Photo / Video
            <input type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
          <label className="tinybtn" style={{ flex: 1, padding: 11, textAlign: "center", cursor: "pointer" }}>
            + Document
            <input type="file" accept="application/pdf,.pdf" multiple style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
        <div style={{ fontSize: 10.5, color: "#9aa093", marginTop: 8 }}>
          Attach photos, video or PDF — recipients view them inline and tap to download.
        </div>

        {files.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #e3e6e0", borderRadius: 9, padding: "7px 10px" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                <span style={{ fontSize: 10.5, color: "#9aa093" }}>{fmtSize(f.size)}</span>
                <span onClick={() => removeFile(i)} style={{ fontSize: 16, color: "#b23a3a", cursor: "pointer", lineHeight: 1 }}>×</span>
              </div>
            ))}
          </div>
        )}

        {/* Layout hints — mirror the desktop composer. Only shown for the media
            actually attached. */}
        {(hasPhotos || hasVideos) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 12, background: "#fff", border: "1px solid var(--line)", borderRadius: 11, padding: "11px 12px" }}>
            {hasPhotos && (
              <div>
                <div className="fld-l" style={{ marginBottom: 6 }}>Photo layout</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["", "1", "2", "3", "4"] as Array<PhotoLayout | "">).map((val) => {
                    const on = photoLayout === val;
                    return (
                      <button key={val || "auto"} onClick={() => setPhotoLayout(val)} className="tinybtn" style={{ padding: "6px 12px", background: on ? "var(--brand)" : "#fff", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}>
                        {val === "" ? "Auto" : val}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {hasVideos && (
              <div>
                <div className="fld-l" style={{ marginBottom: 6 }}>Video layout</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["1x1", "1x2"] as VideoLayout[]).map((val) => {
                    const on = videoLayout === val;
                    return (
                      <button key={val} onClick={() => setVideoLayout(val)} className="tinybtn" style={{ padding: "6px 12px", background: on ? "var(--brand)" : "#fff", borderColor: on ? "var(--brand)" : "var(--line)", color: on ? "#fff" : "var(--ink)" }}>
                        {val === "1x1" ? "1 x 1 (square)" : "1 x 2 (portrait)"}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {err && <div style={{ fontSize: 12, color: "#b23a3a", marginTop: 10 }}>{err}</div>}
      </div>

      <footer className="actbar">
        <button onClick={publish} disabled={saving} className="btn" style={{ cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Publish announcement"}
        </button>
      </footer>
    </div>
  );
}

// A scrollable, bordered checkbox list used by every audience picker.
function PickerBox({ empty, children }: { empty: string | null; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 12, maxHeight: 220, overflowY: "auto" }}>
      {empty ? (
        <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "18px 0" }}>{empty}</div>
      ) : (
        children
      )}
    </div>
  );
}

function CheckRow({ label, sub, checked, onToggle }: { label: string; sub?: string; checked: boolean; onToggle: () => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", cursor: "pointer", borderTop: "1px solid #eceee9" }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ width: 18, height: 18, accentColor: "var(--brand)", flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {sub && <span style={{ display: "block", fontSize: 10.5, color: "#9aa093", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>}
      </span>
    </label>
  );
}
