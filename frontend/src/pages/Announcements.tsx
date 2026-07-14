import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Megaphone,
  Send,
  Trash2,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  BellRing,
  Users as UsersIcon,
  Paperclip,
  X,
  ImageIcon,
  Video,
  FileText,
  File as FileIcon,
  AlertTriangle,
  BookOpen,
  ShieldCheck,
  Globe,
  Building2,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn, relativeTime } from "../lib/utils";
import type { TeamMember, Department, Position } from "../types";

// ────────────────────────────────────────────────────────────────────────────
// Domain types — mirrors backend/src/routes/announcements.ts public shape.
// ────────────────────────────────────────────────────────────────────────────
type Attachment = {
  r2Key: string;
  name: string;
  mime: string;
  size?: number;
};

type TargetType =
  | "ALL_USERS"
  | "DEPARTMENT_IDS"
  | "POSITION_IDS"
  | "USER_IDS"
  | "MIXED";

type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

type Announcement = {
  id: string;
  title: string;
  body: string;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  createdBy: number | null;
  remindedAt: string | null;
  updatedAt: string | null;
  attachments?: Attachment[];
  targetType?: TargetType;
  targetDeptIds?: number[];
  targetPositionIds?: number[];
  targetUserIds?: number[];
  targetCompanyIds?: number[];
  category?: AnnouncementCategory;
};

type Company = { id: number; code: string; name: string };
type CompaniesResponse = { companies?: Company[] };

type ListResponse = { success?: boolean; data?: Announcement[] };

type AckedUser = {
  id: number;
  name: string;
  email: string;
  ackedAt: string | null;
};
type PendingUser = { id: number; name: string; email: string };
type AcksResponse = {
  success?: boolean;
  data?: {
    total: number;
    ackedCount: number;
    acked: AckedUser[];
    pending: PendingUser[];
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Constants — category metadata mirrors Hookka's ANNOUNCEMENT_CATEGORIES.
// ────────────────────────────────────────────────────────────────────────────
const CATEGORY_ORDER: AnnouncementCategory[] = [
  "GENERAL",
  "WARNING",
  "SOP",
  "LEARNING",
];
const CATEGORY_META: Record<
  AnnouncementCategory,
  {
    label: string;
    icon: typeof Megaphone;
    pillCls: string;
  }
> = {
  GENERAL: {
    label: "General",
    icon: Megaphone,
    pillCls: "bg-surface-dim text-ink-secondary border-border",
  },
  WARNING: {
    label: "Warning",
    icon: AlertTriangle,
    pillCls: "bg-err/10 text-err border-err/30",
  },
  SOP: {
    label: "SOP",
    icon: ShieldCheck,
    pillCls: "bg-accent/10 text-accent border-accent/30",
  },
  LEARNING: {
    label: "Learning",
    icon: BookOpen,
    pillCls: "bg-primary/10 text-primary border-primary/30",
  },
};

function attachmentKind(mime: string): "image" | "video" | "pdf" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

function fmtTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

function CategoryBadge({ category }: { category: AnnouncementCategory }) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider",
        meta.pillCls,
      )}
    >
      <Icon size={11} />
      {meta.label}
    </span>
  );
}

// Resolve the company-scope of a notice to a compact chip label. Empty target
// (or one covering every company) = "Both"/"All"; a subset lists the codes.
function companyScopeLabel(
  ids: number[] | undefined,
  companies: Company[],
): string {
  const list = ids ?? [];
  if (companies.length === 0) return "";
  if (list.length === 0 || list.length >= companies.length) {
    return companies.length === 2 ? "Both" : "All companies";
  }
  return list
    .map((id) => companies.find((co) => co.id === id)?.code ?? `#${id}`)
    .join(" / ");
}

// A small company-scope chip shown on each row (multi-company only).
function CompanyBadge({
  ids,
  companies,
}: {
  ids: number[] | undefined;
  companies: Company[];
}) {
  if (companies.length <= 1) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-dim px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-secondary">
      <Building2 size={11} />
      {companyScopeLabel(ids, companies)}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────
export function Announcements() {
  const { can } = useAuth();
  const toast = useToast();
  const canWrite = can("announcements.write");

  const listQ = useQuery<ListResponse>(() => api.get("/api/announcements"));
  const items = listQ.data?.data ?? [];

  // Lookups for the audience pickers + the "To: …" pill resolver.
  const usersQ = useQuery<{ users: TeamMember[] }>(() => api.get("/api/users"));
  const deptsQ = useQuery<{ departments: Department[] }>(() =>
    api.get("/api/departments"),
  );
  const positionsQ = useQuery<{ positions: Position[] }>(() =>
    api.get("/api/positions"),
  );
  // Multi-company: the company-target selector + row chip only appear when the
  // companies master returns MORE THAN ONE company (mirrors the top-bar
  // CompanySwitcher no-op rule). Single-company Houzs shows neither.
  const companiesQ = useQuery<CompaniesResponse>(() =>
    api.get("/api/companies"),
  );

  const users = usersQ.data?.users ?? [];
  const depts = deptsQ.data?.departments ?? [];
  const positions = positionsQ.data?.positions ?? [];
  const companies = companiesQ.data?.companies ?? [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-5">
      <PageHeader
        eyebrow="Workspace · Communications"
        title="Announcements"
        description="Post office-wide notices and track who has acknowledged them."
      />

      {canWrite && (
        <Composer
          users={users}
          departments={depts}
          positions={positions}
          companies={companies}
          onPosted={() => listQ.reload()}
        />
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="flex items-center gap-2 px-1 text-[12.5px] font-semibold uppercase tracking-wider text-ink-secondary">
          <Megaphone size={13} />
          Posted Announcements
          <span className="text-ink-muted">({items.length})</span>
        </h2>
        {listQ.loading ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-[12px] text-ink-muted">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-10 text-center text-[12px] text-ink-muted">
            Nothing posted yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {items.map((a) => (
              <AnnouncementRow
                key={a.id}
                announcement={a}
                users={users}
                departments={depts}
                positions={positions}
                companies={companies}
                canWrite={canWrite}
                onChanged={() => listQ.reload()}
                toast={toast}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Composer — top-of-page create form.
// ────────────────────────────────────────────────────────────────────────────
type Bucket = "ALL" | "DEPT" | "POSITION" | "USER";

function Composer({
  users,
  departments,
  positions,
  companies,
  onPosted,
}: {
  users: TeamMember[];
  departments: Department[];
  positions: Position[];
  companies: Company[];
  onPosted: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [category, setCategory] = useState<AnnouncementCategory>("GENERAL");
  const [bucket, setBucket] = useState<Bucket>("ALL");
  // Company target: "ALL" = every company (Both — sends no target, NULL = all);
  // a company id = that company only. Default "ALL" so an untargeted notice
  // reaches everyone. Only rendered when >1 company exists.
  const [companyPick, setCompanyPick] = useState<"ALL" | number>("ALL");
  const [selectedDepts, setSelectedDepts] = useState<Set<number>>(new Set());
  const [selectedPositions, setSelectedPositions] = useState<Set<number>>(
    new Set(),
  );
  const [selectedUsers, setSelectedUsers] = useState<Set<number>>(new Set());
  const [userSearch, setUserSearch] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [posting, setPosting] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    const active = users.filter((u) => u.status === "active");
    if (!q) return active;
    return active.filter(
      (u) =>
        (u.name ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q),
    );
  }, [users, userSearch]);

  const onPickFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploadErr(null);
      const next: Attachment[] = [];
      for (const f of Array.from(files)) {
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        try {
          const res = await api.putBinary<{
            r2Key: string;
            mime: string;
            size: number;
          }>(`/api/announcements/compose/attachments/upload?ext=${ext}`, f, f.type);
          next.push({
            r2Key: res.r2Key,
            name: f.name,
            mime: f.type || res.mime,
            size: res.size,
          });
        } catch (e: any) {
          setUploadErr(e?.message || "Upload failed");
          break;
        }
      }
      if (next.length) setAttachments((prev) => [...prev, ...next]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [],
  );

  function toggleSet(set: Set<number>, id: number): Set<number> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function pickBucket(b: Bucket) {
    setBucket(b);
    if (b === "ALL") {
      setSelectedDepts(new Set());
      setSelectedPositions(new Set());
      setSelectedUsers(new Set());
    }
  }

  async function post() {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      toast.error("Title is required");
      return;
    }
    setPosting(true);
    try {
      const body: Record<string, unknown> = {
        title: cleanTitle,
        body: text.trim(),
        category,
        attachments,
      };
      if (bucket === "DEPT") body.targetDeptIds = Array.from(selectedDepts);
      if (bucket === "POSITION")
        body.targetPositionIds = Array.from(selectedPositions);
      if (bucket === "USER") body.targetUserIds = Array.from(selectedUsers);
      // Company target: a single company sends [id]; "Both"/ALL omits the field
      // (backend stores NULL = all companies).
      if (companyPick !== "ALL") body.targetCompanyIds = [companyPick];
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      await api.post("/api/announcements", body);
      // Reset.
      setTitle("");
      setText("");
      setCategory("GENERAL");
      setBucket("ALL");
      setCompanyPick("ALL");
      setSelectedDepts(new Set());
      setSelectedPositions(new Set());
      setSelectedUsers(new Set());
      setExpiresAt("");
      setAttachments([]);
      toast.success("Announcement posted");
      onPosted();
    } catch (e: any) {
      toast.error(e?.message || "Failed to post");
    } finally {
      setPosting(false);
    }
  }

  const canPost = !posting && title.trim().length > 0;
  const companyOptions: Array<["ALL" | number, string]> = [
    ["ALL", "Both"],
    ...companies.map((co) => [co.id, co.name] as ["ALL" | number, string]),
  ];

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
        <Megaphone size={14} className="text-ink-muted" />
        <div className="text-[12px] font-bold uppercase tracking-wider text-ink-secondary">
          New Announcement
        </div>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="What's the announcement?"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Message
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="Add the details (optional)"
            className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Attachments */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
              Attachments
            </label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
            >
              <Paperclip size={11} />
              Attach files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*,application/pdf"
              onChange={(e) => onPickFiles(e.target.files)}
              className="hidden"
            />
          </div>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a, i) => {
                const Icon =
                  attachmentKind(a.mime) === "image"
                    ? ImageIcon
                    : attachmentKind(a.mime) === "video"
                    ? Video
                    : attachmentKind(a.mime) === "pdf"
                    ? FileText
                    : FileIcon;
                return (
                  <span
                    key={a.r2Key + i}
                    className="inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-border bg-surface-dim px-2 py-0.5 text-[11px] text-ink"
                  >
                    <Icon size={11} className="shrink-0 text-ink-muted" />
                    <span className="truncate">{a.name}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="ml-1 rounded-full p-0.5 text-ink-muted hover:bg-surface hover:text-err"
                      aria-label="Remove"
                    >
                      <X size={10} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {uploadErr && (
            <p className="mt-1 text-[11px] text-err">{uploadErr}</p>
          )}
        </div>

        {/* Company target — only when more than one company exists. */}
        {companies.length > 1 && (
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
              Company
            </label>
            <div className="flex flex-wrap gap-1.5">
              {companyOptions.map(([key, label]) => {
                const selected = companyPick === key;
                return (
                  <button
                    key={String(key)}
                    type="button"
                    onClick={() => setCompanyPick(key)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                      selected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                    )}
                  >
                    <Building2 size={12} />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Category */}
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Category
          </label>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORY_ORDER.map((c) => {
              const m = CATEGORY_META[c];
              const Icon = m.icon;
              const selected = category === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                    selected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                  )}
                >
                  <Icon size={12} />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Recipients */}
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Recipients
          </label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(
              [
                ["ALL", "All users", Globe],
                ["DEPT", "Departments", UsersIcon],
                ["POSITION", "Positions", ShieldCheck],
                ["USER", "Specific people", UsersIcon],
              ] as Array<[Bucket, string, typeof Globe]>
            ).map(([key, label, Icon]) => {
              const selected = bucket === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => pickBucket(key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                    selected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                  )}
                >
                  <Icon size={12} />
                  {label}
                </button>
              );
            })}
          </div>

          {bucket === "DEPT" && (
            <div className="rounded-md border border-border bg-surface-dim p-2.5">
              <div className="flex flex-wrap gap-1.5">
                {departments.length === 0 ? (
                  <span className="text-[11.5px] text-ink-muted">
                    No departments
                  </span>
                ) : (
                  departments.map((d) => {
                    const on = selectedDepts.has(d.id);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() =>
                          setSelectedDepts((prev) => toggleSet(prev, d.id))
                        }
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold transition-colors",
                          on
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                        )}
                      >
                        {d.name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {bucket === "POSITION" && (
            <div className="rounded-md border border-border bg-surface-dim p-2.5">
              <div className="flex flex-wrap gap-1.5">
                {positions.length === 0 ? (
                  <span className="text-[11.5px] text-ink-muted">
                    No positions
                  </span>
                ) : (
                  positions.map((p) => {
                    const on = selectedPositions.has(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          setSelectedPositions((prev) =>
                            toggleSet(prev, p.id),
                          )
                        }
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold transition-colors",
                          on
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                        )}
                      >
                        {p.name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {bucket === "USER" && (
            <div className="rounded-md border border-border bg-surface-dim p-2.5">
              <input
                type="text"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="mb-2 h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <div className="max-h-48 overflow-auto rounded border border-border bg-surface">
                {filteredUsers.length === 0 ? (
                  <div className="px-2.5 py-2 text-[11.5px] text-ink-muted">
                    No matching users.
                  </div>
                ) : (
                  filteredUsers.map((u) => {
                    const on = selectedUsers.has(u.id);
                    return (
                      <label
                        key={u.id}
                        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-surface-dim"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setSelectedUsers((prev) => toggleSet(prev, u.id))
                          }
                        />
                        <span className="truncate">
                          {u.name || u.email}
                          {u.email && u.name && (
                            <span className="ml-1 text-ink-muted">
                              · {u.email}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
            Hide automatically after
          </label>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="h-10 rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            variant="primary"
            onClick={post}
            disabled={!canPost}
            icon={<Send size={13} />}
          >
            {posting ? "Posting…" : "Post Announcement"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// One row in the Posted list.
// ────────────────────────────────────────────────────────────────────────────
function AnnouncementRow({
  announcement: a,
  users,
  departments,
  positions,
  companies,
  canWrite,
  onChanged,
  toast,
}: {
  announcement: Announcement;
  users: TeamMember[];
  departments: Department[];
  positions: Position[];
  companies: Company[];
  canWrite: boolean;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [acksOpen, setAcksOpen] = useState(false);
  const [acks, setAcks] = useState<AcksResponse["data"] | null>(null);
  const [acksLoading, setAcksLoading] = useState(false);

  const expired =
    a.expiresAt != null && Date.parse(a.expiresAt) <= Date.now();
  const statusText = !a.isActive
    ? "Hidden"
    : expired
    ? "Expired"
    : "Live";
  const statusCls = !a.isActive
    ? "bg-surface-dim text-ink-muted border-border"
    : expired
    ? "bg-surface-dim text-ink-muted border-border"
    : "bg-synced/10 text-synced border-synced/30";

  const audienceLabel = useMemo(() => {
    const t = a.targetType ?? "ALL_USERS";
    if (t === "ALL_USERS") return "Everyone";
    const parts: string[] = [];
    const deptMap = new Map(departments.map((d) => [d.id, d.name]));
    const posMap = new Map(positions.map((p) => [p.id, p.name]));
    const userMap = new Map(users.map((u) => [u.id, u.name || u.email]));
    if (a.targetDeptIds?.length) {
      parts.push(
        `Departments: ${a.targetDeptIds
          .map((id) => deptMap.get(id) ?? `#${id}`)
          .join(", ")}`,
      );
    }
    if (a.targetPositionIds?.length) {
      parts.push(
        `Positions: ${a.targetPositionIds
          .map((id) => posMap.get(id) ?? `#${id}`)
          .join(", ")}`,
      );
    }
    if (a.targetUserIds?.length) {
      parts.push(
        `People: ${a.targetUserIds
          .map((id) => userMap.get(id) ?? `#${id}`)
          .join(", ")}`,
      );
    }
    return parts.length ? parts.join(" · ") : "—";
  }, [a, departments, positions, users]);

  async function loadAcks() {
    setAcksLoading(true);
    try {
      const r = await api.get<AcksResponse>(`/api/announcements/${a.id}/acks`);
      setAcks(r.data ?? null);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load read receipts");
    } finally {
      setAcksLoading(false);
    }
  }

  function toggleAcksPanel() {
    const next = !acksOpen;
    setAcksOpen(next);
    if (next) void loadAcks();
  }

  async function toggleActive() {
    try {
      await api.patch(`/api/announcements/${a.id}`, { isActive: !a.isActive });
      toast.success(a.isActive ? "Announcement hidden" : "Announcement shown");
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function doDelete() {
    const ok = await dialog.confirm({
      title: "Delete announcement",
      message: `Permanently delete "${a.title}"? Read-receipts will also be removed. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/announcements/${a.id}`);
      toast.success("Announcement deleted");
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Failed to delete");
    }
  }

  async function remindUnacked() {
    const pending = acks?.pending.length ?? 0;
    const ok = await dialog.confirm({
      title: "Send reminder",
      message: `Re-pop the banner for ${pending} un-acknowledged user${
        pending === 1 ? "" : "s"
      }? Anyone who already tapped Got it will be unaffected.`,
      confirmLabel: "Remind",
    });
    if (!ok) return;
    try {
      const r = await api.post<{ pendingCount: number }>(
        `/api/announcements/${a.id}/remind`,
        { scope: "unacked" },
      );
      toast.success(
        `Reminder set — will re-pop for ${r.pendingCount} user${
          r.pendingCount === 1 ? "" : "s"
        }`,
      );
      onChanged();
      void loadAcks();
    } catch (e: any) {
      toast.error(e?.message || "Failed to remind");
    }
  }

  async function remindAll() {
    const total = acks?.total ?? 0;
    const ok = await dialog.confirm({
      title: "Reset all read-receipts",
      message: `Wipe acknowledgements and re-pop for ALL ${total} active user${
        total === 1 ? "" : "s"
      }? Everyone (including those who already acknowledged) will see the popup again.`,
      confirmLabel: "Reset and remind",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.post<{ pendingCount: number }>(
        `/api/announcements/${a.id}/remind`,
        { scope: "all" },
      );
      toast.success(
        `Reset — banner re-pops for ${r.pendingCount} user${
          r.pendingCount === 1 ? "" : "s"
        }`,
      );
      onChanged();
      void loadAcks();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reset");
    }
  }

  return (
    <li className="rounded-lg border border-border bg-surface p-3.5 shadow-stone">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <CategoryBadge category={a.category ?? "GENERAL"} />
            <CompanyBadge ids={a.targetCompanyIds} companies={companies} />
            <span className="truncate text-[14px] font-semibold text-ink">
              {a.title}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                statusCls,
              )}
            >
              {statusText}
            </span>
          </div>
          {a.body && (
            <p className="whitespace-pre-wrap text-[12.5px] text-ink-secondary">
              {a.body}
            </p>
          )}

          {a.attachments && a.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {a.attachments.map((att, i) => (
                <AttachmentChip key={att.r2Key + i} att={att} annId={a.id} />
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-dim px-2 py-0.5">
              {a.targetType === "ALL_USERS" ? (
                <Globe size={10} />
              ) : (
                <UsersIcon size={10} />
              )}
              To: {audienceLabel}
            </span>
            <span>
              Posted {a.createdAt ? relativeTime(a.createdAt) : "—"}
              {a.expiresAt && ` · hides ${relativeTime(a.expiresAt)}`}
              {a.remindedAt && ` · reminded ${relativeTime(a.remindedAt)}`}
            </span>
          </div>

          <button
            type="button"
            onClick={toggleAcksPanel}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface-dim px-2 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
          >
            {acksOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <UsersIcon size={11} />
            {acks
              ? `Read ${acks.ackedCount} of ${acks.total}`
              : "Read receipts"}
          </button>

          {acksOpen && (
            <div className="mt-2 rounded-md border border-border bg-surface-dim p-2.5">
              {acksLoading ? (
                <div className="text-[11.5px] text-ink-muted">Loading…</div>
              ) : !acks ? (
                <div className="text-[11.5px] text-ink-muted">No data.</div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded border border-border bg-surface p-2">
                    <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-secondary">
                      Acknowledged ({acks.acked.length})
                    </div>
                    {acks.acked.length === 0 ? (
                      <div className="text-[11.5px] text-ink-muted">
                        Nobody yet.
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-0.5 text-[11.5px]">
                        {acks.acked.map((u) => (
                          <li key={u.id} className="flex justify-between gap-2">
                            <span className="truncate">
                              {u.name || u.email}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                              {u.ackedAt ? relativeTime(u.ackedAt) : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="rounded border border-border bg-surface p-2">
                    <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-secondary">
                      Not yet ({acks.pending.length})
                    </div>
                    {acks.pending.length === 0 ? (
                      <div className="text-[11.5px] text-ink-muted">
                        Everybody acknowledged.
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-0.5 text-[11.5px]">
                        {acks.pending.map((u) => (
                          <li key={u.id} className="truncate">
                            {u.name || u.email}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
              {canWrite && acks && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {acks.pending.length > 0 && (
                    <button
                      type="button"
                      onClick={remindUnacked}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
                    >
                      <BellRing size={11} />
                      Remind un-acknowledged ({acks.pending.length})
                    </button>
                  )}
                  {acks.total > 0 && (
                    <button
                      type="button"
                      onClick={remindAll}
                      className="inline-flex items-center gap-1 rounded-md border border-err/30 bg-surface px-2.5 py-1 text-[11px] font-semibold text-err hover:bg-err/5"
                    >
                      <BellRing size={11} />
                      Remind all ({acks.total})
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-1.5 md:shrink-0">
            <button
              type="button"
              onClick={toggleActive}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
              title={fmtTimestamp(a.updatedAt)}
            >
              {a.isActive ? <EyeOff size={11} /> : <Eye size={11} />}
              {a.isActive ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              onClick={doDelete}
              className="inline-flex items-center gap-1 rounded-md border border-err/30 bg-surface px-2.5 py-1 text-[11px] font-semibold text-err hover:bg-err/5"
            >
              <Trash2 size={11} />
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function AttachmentChip({ att, annId }: { att: Attachment; annId: string }) {
  const kind = attachmentKind(att.mime);
  const Icon =
    kind === "image"
      ? ImageIcon
      : kind === "video"
      ? Video
      : kind === "pdf"
      ? FileText
      : FileIcon;
  // The download path requires the announcements.read permission server-side.
  // The full r2Key is URL-safe (no spaces, no double-slash collisions) so we
  // encode it as a single segment; the route matcher uses :key{.+}.
  const href = `${api.baseUrl}/api/announcements/${annId}/attachments/${att.r2Key}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-border bg-surface-dim px-2 py-0.5 text-[11px] text-ink hover:border-accent/40 hover:text-accent"
      title={att.name}
    >
      <Icon size={11} className="shrink-0 text-ink-muted" />
      <span className="truncate">{att.name}</span>
    </a>
  );
}
