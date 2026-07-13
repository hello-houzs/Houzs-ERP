// ============================================================
// Announcements — office posts every logged-in user sees as a top-of-screen
// banner with a "Got it" acknowledgement. Ported from Hookka
// (src/api/routes/announcements.ts), adapted for Houzs:
//   - Single-tenant (no org_id).
//   - No worker portal: every user is office staff who logs in via /api/auth.
//   - Targeting reframed: ALL_USERS | DEPARTMENT_IDS | POSITION_IDS | USER_IDS
//     | MIXED. Lists hold INTEGER ids (matches users.id / departments.id /
//     positions.id). Workers / dept-codes don't exist on this side.
//   - No web push (Houzs has no push_subscriptions). BrowserPushSink already
//     fires native Notifications off the polled activity feed; reusing that
//     here is a future enhancement.
//   - Translate-announcement.ts is ported and called best-effort. Returns null
//     when ANTHROPIC_API_KEY is unset → FE falls back to original text.
//   - No runtime self-apply DDL block: Houzs migrates-before-deploy
//     (mig 0058 must be applied before this route's first request).
// ============================================================
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { hasPermission } from "../services/permissions";
import { activeCompanyId } from "../scm/lib/companyScope";
import {
  translateAnnouncement,
  type AnnouncementTranslations,
} from "../lib/translate-announcement";

const app = new Hono<{ Bindings: Env }>();

// Multi-company: announcements are PER-COMPANY (a 2990 user must not see
// Houzs office notices and vice versa). Every read below adds the active
// company predicate CONDITIONALLY — when the companies master is unresolved
// (pre-migration 0093, the D1 test mirror, or a DB cold-start) the predicate
// is skipped entirely so single-company Houzs keeps serving unchanged. This
// mirrors the raw-SQL idiom in routes/sales.ts.

// The four announcement categories. GENERAL is the back-compat default.
type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

// Targeting kinds. ALL_USERS = everyone (the back-compat default).
type TargetType =
  | "ALL_USERS"
  | "DEPARTMENT_IDS"
  | "POSITION_IDS"
  | "USER_IDS"
  | "MIXED";

// One attached media file on an announcement. `r2Key` lives in POD_BUCKET.
// `name` is the original filename; `mime` drives the renderer (image/video/pdf).
type AnnouncementAttachment = {
  r2Key: string;
  name: string;
  mime: string;
  size?: number;
};

// Raw row shape from the DB (dual-keyed because the pg driver folds
// snake_case -> camelCase on read — the #1 Hookka read-gotcha).
type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  is_active?: number | boolean | null;
  isActive?: number | boolean | null;
  expires_at?: string | null;
  expiresAt?: string | null;
  reminded_at?: string | null;
  remindedAt?: string | null;
  created_by?: number | null;
  createdBy?: number | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
  translations?: AnnouncementTranslations | string | null;
  attachments?: string | unknown[] | null;
  target_type?: string | null;
  targetType?: string | null;
  target_dept_ids?: string | number[] | null;
  targetDeptIds?: string | number[] | null;
  target_position_ids?: string | number[] | null;
  targetPositionIds?: string | number[] | null;
  target_user_ids?: string | number[] | null;
  targetUserIds?: string | number[] | null;
  category?: string | null;
  source?: string | null;
  company_id?: number | null;
  companyId?: number | null;
};

function readCategory(v: unknown): AnnouncementCategory {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "WARNING" || s === "SOP" || s === "LEARNING") return s;
  return "GENERAL";
}

function isActiveFlag(v: number | boolean | null | undefined): boolean {
  return v === true || v === 1;
}

function notExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t > Date.now();
}

function isRemindedSince(
  remindedAt: string | null,
  ackedAt: string | null,
): boolean {
  if (!remindedAt || !ackedAt) return false;
  const r = Date.parse(remindedAt);
  const a = Date.parse(ackedAt);
  if (Number.isNaN(r) || Number.isNaN(a)) return false;
  return r > a;
}

function readTranslations(r: AnnouncementRow): AnnouncementTranslations | null {
  const raw = r.translations ?? null;
  if (raw == null) return null;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as AnnouncementTranslations;
    } catch {
      return null;
    }
  }
  return raw;
}

// Parse a stored JSON array of integers. Tolerates a JSON string OR a parsed
// array; drops non-numbers; deduplicates.
function readIntArray(v: string | number[] | null | undefined): number[] {
  if (v == null) return [];
  let arr: unknown = v;
  if (typeof v === "string") {
    if (!v.trim()) return [];
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of arr) {
    const n = typeof x === "number" ? x : parseInt(String(x), 10);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function normalizeAttachments(raw: unknown): AnnouncementAttachment[] {
  let arr: unknown = raw;
  if (typeof arr === "string") {
    const s = arr.trim();
    if (!s) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: AnnouncementAttachment[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const r2Key = String(o.r2Key ?? o.r2_key ?? "").trim();
    if (!r2Key) continue;
    const att: AnnouncementAttachment = {
      r2Key,
      name: String(o.name ?? "").trim(),
      mime: String(o.mime ?? o.contentType ?? "").trim(),
    };
    const size = Number(o.size);
    if (Number.isFinite(size) && size > 0) att.size = size;
    out.push(att);
  }
  return out;
}

function readTargetType(r: AnnouncementRow): TargetType {
  const t = String(r.targetType ?? r.target_type ?? "ALL_USERS").toUpperCase();
  if (
    t === "DEPARTMENT_IDS" ||
    t === "POSITION_IDS" ||
    t === "USER_IDS" ||
    t === "MIXED"
  )
    return t;
  return "ALL_USERS";
}

// Derive the canonical target_type from which target lists are non-empty.
// Empty all -> ALL_USERS; one bucket -> that bucket's enum; multiple -> MIXED.
function deriveTargetType(
  deptIds: number[],
  positionIds: number[],
  userIds: number[],
): TargetType {
  const buckets =
    (deptIds.length > 0 ? 1 : 0) +
    (positionIds.length > 0 ? 1 : 0) +
    (userIds.length > 0 ? 1 : 0);
  if (buckets === 0) return "ALL_USERS";
  if (buckets > 1) return "MIXED";
  if (deptIds.length > 0) return "DEPARTMENT_IDS";
  if (positionIds.length > 0) return "POSITION_IDS";
  return "USER_IDS";
}

function toPublic(r: AnnouncementRow) {
  return {
    id: r.id,
    title: r.title,
    body: r.body ?? "",
    isActive: isActiveFlag(r.isActive ?? r.is_active ?? null),
    expiresAt: r.expiresAt ?? r.expires_at ?? null,
    createdAt: r.createdAt ?? r.created_at ?? null,
    createdBy: r.createdBy ?? r.created_by ?? null,
    remindedAt: r.remindedAt ?? r.reminded_at ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
    translations: readTranslations(r),
    attachments: normalizeAttachments(r.attachments ?? null),
    targetType: readTargetType(r),
    targetDeptIds: readIntArray(r.targetDeptIds ?? r.target_dept_ids ?? null),
    targetPositionIds: readIntArray(
      r.targetPositionIds ?? r.target_position_ids ?? null,
    ),
    targetUserIds: readIntArray(r.targetUserIds ?? r.target_user_ids ?? null),
    category: readCategory(r.category),
    // System-notice tag ('scan' for background slip-scan results). Lets the
    // client suppress the read-receipt roster on private per-user notices.
    source: (r.source ?? null) as string | null,
  };
}

function genId(): string {
  return `ann-${crypto.randomUUID().slice(0, 12).replace(/-/g, "")}`;
}

// Fetch one announcement scoped to the active company. A cross-company id
// resolves to null (callers answer 404, indistinguishable from a nonexistent
// id). Predicate skipped when the company context is unresolved.
async function getScopedAnnouncement(
  c: { env: Env; get: (k: string) => unknown },
  id: string,
): Promise<AnnouncementRow | null> {
  const companyId = activeCompanyId(c as never);
  const row = await c.env.DB.prepare(
    `SELECT * FROM announcements WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`,
  )
    .bind(id, ...(companyId != null ? [companyId] : []))
    .first<AnnouncementRow>();
  return row ?? null;
}

/**
 * Company filter for the active-user roster (read-receipts + reminders).
 * users has no company column — per-company access lives in `user_companies`
 * (mig 0085) with the same FAIL-OPEN rule as companyContext: a user with NO
 * grant rows belongs to every company; a user WITH grants belongs only to
 * those. Returns "" (no filter) when the company context is unresolved.
 */
function rosterCompanySql(companyId: number | undefined, alias = "users"): string {
  if (companyId == null) return "";
  const cid = Number(companyId);
  if (!Number.isInteger(cid) || cid <= 0) return "";
  return ` AND (NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = ${alias}.id)
             OR EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = ${alias}.id AND uc.company_id = ${cid}))`;
}

// True when a user with (id, deptId, positionId) is in the announcement's
// audience. Used by the banner GET so we never surface a notice the user
// shouldn't see.
function userCanSee(
  r: AnnouncementRow,
  userId: number,
  userDeptId: number | null,
  userPositionId: number | null,
): boolean {
  const type = readTargetType(r);
  if (type === "ALL_USERS") return true;
  const deptIds = readIntArray(r.targetDeptIds ?? r.target_dept_ids ?? null);
  if (userDeptId != null && deptIds.includes(userDeptId)) return true;
  const positionIds = readIntArray(
    r.targetPositionIds ?? r.target_position_ids ?? null,
  );
  if (userPositionId != null && positionIds.includes(userPositionId)) return true;
  const userIds = readIntArray(r.targetUserIds ?? r.target_user_ids ?? null);
  if (userIds.includes(userId)) return true;
  return false;
}

// ============================================================
// LIST — newest first.
//   · Managers (`*` wildcard or announcements.write, i.e. composers) get the
//     FULL admin list: every active + inactive + expired row.
//   · Everyone else with announcements.read gets ONLY live announcements
//     addressed to THEM (owner rule 2026-07: audience-targeted content —
//     same active + not-expired + audience filter as /banner). Server-side;
//     the composer's targeting can't be bypassed by a read-only caller.
// ============================================================
app.get("/", requirePermission("announcements.read"), async (c) => {
  // System per-user notices (source='scan') are delivered only through the
  // /banner + mobile Announcements screen — they must NOT clutter this office
  // composer list. Human-authored posts have source NULL.
  const companyId = activeCompanyId(c);
  const stmt = c.env.DB.prepare(
    `SELECT * FROM announcements WHERE (source IS NULL OR source <> 'scan')${
      companyId != null ? " AND company_id = ?" : ""
    } ORDER BY created_at DESC`,
  );
  const res = await (companyId != null ? stmt.bind(companyId) : stmt).all<AnnouncementRow>();
  const user = c.get("user");
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  const isManager =
    hasPermission(granted, "*") || hasPermission(granted, "announcements.write");
  const rows = isManager
    ? (res.results ?? [])
    : (res.results ?? []).filter(
        (r) =>
          isActiveFlag(r.isActive ?? r.is_active ?? null) &&
          notExpired(r.expiresAt ?? r.expires_at ?? null) &&
          userCanSee(
            r,
            user!.id,
            user!.department_id ?? null,
            user!.position_id ?? null,
          ),
      );
  return c.json({ success: true, data: rows.map(toPublic) });
});

// ============================================================
// BANNER (every authed user) — newest ACTIVE + not-expired + audience-matching
// row + this user's acked ids (for the popup gate). No permission gate: anyone
// who passes the /api/* auth wall can see their own banner.
// ============================================================
app.get("/banner", async (c) => {
  const user = c.get("user");
  if (!user || !user.id) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const companyId = activeCompanyId(c);
  const bannerStmt = c.env.DB.prepare(
    `SELECT * FROM announcements${
      companyId != null ? " WHERE company_id = ?" : ""
    } ORDER BY created_at DESC`,
  );
  const res = await (companyId != null ? bannerStmt.bind(companyId) : bannerStmt).all<AnnouncementRow>();
  const active = (res.results ?? []).filter(
    (r) =>
      isActiveFlag(r.isActive ?? r.is_active ?? null) &&
      notExpired(r.expiresAt ?? r.expires_at ?? null) &&
      userCanSee(
        r,
        user.id,
        user.department_id ?? null,
        user.position_id ?? null,
      ),
  );

  // This user's ack rows (id + when they acked). The popup gate re-pops a
  // notice the user has NOT acked, OR has acked but was reminded AFTER that
  // ack. Read dual-keyed (pg folds snake -> camel on read).
  const ackRes = await c.env.DB.prepare(
    "SELECT announcement_id, acked_at FROM announcement_acks WHERE user_id = ?",
  )
    .bind(user.id)
    .all<{
      announcement_id?: string;
      announcementId?: string;
      acked_at?: string | null;
      ackedAt?: string | null;
    }>();
  const ackedAtById = new Map<string, string | null>();
  for (const a of ackRes.results ?? []) {
    const id = a.announcementId ?? a.announcement_id;
    if (id) ackedAtById.set(id, a.ackedAt ?? a.acked_at ?? null);
  }
  const ackedIds: string[] = [];
  for (const r of active) {
    if (!ackedAtById.has(r.id)) continue;
    const ackedAt = ackedAtById.get(r.id) ?? null;
    const remindedAt = r.remindedAt ?? r.reminded_at ?? null;
    if (isRemindedSince(remindedAt, ackedAt)) continue;
    ackedIds.push(r.id);
  }

  return c.json({
    success: true,
    data: active.map(toPublic),
    ackedIds,
  });
});

// ============================================================
// GET /:id/acks — read-receipt for one notice. Roster = the notice's ACTUAL
// audience (not the whole company), split into who has acked and who hasn't, so
// a private USER_IDS notice reads "Read 1 / 1", not "1 / 48".
// Gated on announcements.WRITE — only publishers/admins see who read a notice
// (owner: a normal user must not see the read-receipts). The frontend already
// only renders this for write-holders; this is the server-side backstop.
// ============================================================
app.get("/:id/acks", requirePermission("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }

  // Only the active users this notice actually targets (userCanSee respects
  // ALL_USERS / DEPARTMENT_IDS / POSITION_IDS / USER_IDS / MIXED), narrowed to
  // the notice's company (user_companies grants, fail-open — see helper).
  const rosterRes = await c.env.DB.prepare(
    `SELECT id, email, name, department_id, position_id FROM users
      WHERE status = 'active'${rosterCompanySql(activeCompanyId(c))}
      ORDER BY name ASC`,
  ).all<{
    id: number;
    email?: string | null;
    name?: string | null;
    department_id?: number | null;
    position_id?: number | null;
  }>();
  const roster = (rosterRes.results ?? []).filter((u) =>
    userCanSee(ann, u.id, u.department_id ?? null, u.position_id ?? null),
  );

  const ackRes = await c.env.DB.prepare(
    "SELECT user_id, acked_at FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .all<{
      user_id?: number;
      userId?: number;
      acked_at?: string | null;
      ackedAt?: string | null;
    }>();
  const ackedAtByUser = new Map<number, string | null>();
  for (const a of ackRes.results ?? []) {
    const uid = a.userId ?? a.user_id;
    if (uid != null) ackedAtByUser.set(uid, a.ackedAt ?? a.acked_at ?? null);
  }

  const acked: Array<{
    id: number;
    name: string;
    email: string;
    ackedAt: string | null;
  }> = [];
  const pending: Array<{ id: number; name: string; email: string }> = [];
  for (const u of roster) {
    const name = u.name ?? "";
    const email = u.email ?? "";
    if (ackedAtByUser.has(u.id)) {
      acked.push({
        id: u.id,
        name,
        email,
        ackedAt: ackedAtByUser.get(u.id) ?? null,
      });
    } else {
      pending.push({ id: u.id, name, email });
    }
  }
  acked.sort((x, y) => {
    const tx = x.ackedAt ? Date.parse(x.ackedAt) : 0;
    const ty = y.ackedAt ? Date.parse(y.ackedAt) : 0;
    return (Number.isNaN(ty) ? 0 : ty) - (Number.isNaN(tx) ? 0 : tx);
  });

  return c.json({
    success: true,
    data: {
      total: roster.length,
      ackedCount: acked.length,
      acked,
      pending,
    },
  });
});

// ============================================================
// POST / — create. Body validated server-side.
// ============================================================
app.post("/", requirePermission("announcements.write"), async (c) => {
  const user = c.get("user");
  const body = (await c.req
    .json()
    .catch(() => ({}))) as Record<string, unknown>;

  const title = String(body.title ?? "").trim();
  const text = String(body.body ?? "").trim();
  if (!title) {
    return c.json({ success: false, error: "Title is required" }, 400);
  }
  if (title.length > 200) {
    return c.json({ success: false, error: "Title too long (200 max)" }, 400);
  }

  let expiresAt: string | null = null;
  if (body.expiresAt != null && String(body.expiresAt).trim() !== "") {
    const t = Date.parse(String(body.expiresAt));
    if (Number.isNaN(t)) {
      return c.json({ success: false, error: "Invalid expiry date" }, 400);
    }
    expiresAt = new Date(t).toISOString();
  }

  const attachments = normalizeAttachments(body.attachments);
  const reqDeptIds = readIntArray(
    body.targetDeptIds as string | number[] | null | undefined,
  );
  const reqPositionIds = readIntArray(
    body.targetPositionIds as string | number[] | null | undefined,
  );
  const reqUserIds = readIntArray(
    body.targetUserIds as string | number[] | null | undefined,
  );
  const targetType = deriveTargetType(reqDeptIds, reqPositionIds, reqUserIds);
  const category = readCategory(body.category);

  const id = genId();
  const nowIso = new Date().toISOString();
  // Multi-company: stamp the composing company. Column + bind appended ONLY
  // when the company context is resolved (sales.ts idiom) so the pre-migration
  // window / D1 test mirror inserts unchanged; the PG DEFAULT covers the rest.
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;
  // Best-effort translate. apiKey missing -> returns null and we store null;
  // FE falls back to original text. Awaiting is fine (rare + short).
  const translations = await translateAnnouncement({
    title,
    body: text,
    apiKey: c.env.ANTHROPIC_API_KEY,
  });

  await c.env.DB.prepare(
    `INSERT INTO announcements
       (id, title, body, is_active, expires_at, created_by, created_at,
        translations, attachments, target_type,
        target_dept_ids, target_position_ids, target_user_ids, category${stampCo ? ", company_id" : ""})
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
  )
    .bind(
      id,
      title,
      text,
      expiresAt,
      user?.id ?? null,
      nowIso,
      translations ? JSON.stringify(translations) : null,
      attachments.length ? JSON.stringify(attachments) : null,
      targetType,
      reqDeptIds.length ? JSON.stringify(reqDeptIds) : null,
      reqPositionIds.length ? JSON.stringify(reqPositionIds) : null,
      reqUserIds.length ? JSON.stringify(reqUserIds) : null,
      category,
      ...(stampCo ? [companyId] : []),
    )
    .run();

  const row = await c.env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?",
  )
    .bind(id)
    .first<AnnouncementRow>();

  // TODO: web push fan-out (no infra in Houzs yet). BrowserPushSink already
  // fires native browser Notifications from the polled activity feed; wiring
  // announcements into a similar polled trigger is the natural next step.

  return c.json({ success: true, data: row ? toPublic(row) : null }, 201);
});

// ============================================================
// PATCH /:id — edit fields, toggle isActive, retarget, re-translate.
// ============================================================
app.patch("/:id", requirePermission("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  const body = (await c.req
    .json()
    .catch(() => ({}))) as Record<string, unknown>;

  const sets: string[] = [];
  const binds: unknown[] = [];
  let textChanged = false;
  let nextTitle = existing.title;
  let nextText = existing.body ?? "";

  if ("isActive" in body) {
    sets.push("is_active = ?");
    binds.push(body.isActive ? 1 : 0);
  }
  if (typeof body.title === "string") {
    const title = String(body.title).trim();
    if (!title) {
      return c.json({ success: false, error: "Title is required" }, 400);
    }
    if (title.length > 200) {
      return c.json({ success: false, error: "Title too long (200 max)" }, 400);
    }
    sets.push("title = ?");
    binds.push(title);
    nextTitle = title;
    textChanged = true;
  }
  if (typeof body.body === "string") {
    const text = String(body.body).trim();
    sets.push("body = ?");
    binds.push(text);
    nextText = text;
    textChanged = true;
  }
  if ("attachments" in body) {
    const next = normalizeAttachments(body.attachments);
    sets.push("attachments = ?");
    binds.push(next.length ? JSON.stringify(next) : null);
  }
  // Retarget when ANY targeting list is present. We rewrite all four columns
  // together so target_type stays in sync; missing buckets fall back to the
  // existing row's value (so a dept-only edit doesn't wipe a worker list).
  if (
    "targetDeptIds" in body ||
    "targetPositionIds" in body ||
    "targetUserIds" in body
  ) {
    const nextDepts =
      "targetDeptIds" in body
        ? readIntArray(body.targetDeptIds as string | number[] | null | undefined)
        : readIntArray(existing.targetDeptIds ?? existing.target_dept_ids ?? null);
    const nextPositions =
      "targetPositionIds" in body
        ? readIntArray(
            body.targetPositionIds as string | number[] | null | undefined,
          )
        : readIntArray(
            existing.targetPositionIds ?? existing.target_position_ids ?? null,
          );
    const nextUsers =
      "targetUserIds" in body
        ? readIntArray(body.targetUserIds as string | number[] | null | undefined)
        : readIntArray(existing.targetUserIds ?? existing.target_user_ids ?? null);
    sets.push("target_type = ?");
    binds.push(deriveTargetType(nextDepts, nextPositions, nextUsers));
    sets.push("target_dept_ids = ?");
    binds.push(nextDepts.length ? JSON.stringify(nextDepts) : null);
    sets.push("target_position_ids = ?");
    binds.push(nextPositions.length ? JSON.stringify(nextPositions) : null);
    sets.push("target_user_ids = ?");
    binds.push(nextUsers.length ? JSON.stringify(nextUsers) : null);
  }
  if ("category" in body) {
    sets.push("category = ?");
    binds.push(readCategory(body.category));
  }
  if ("expiresAt" in body) {
    const raw = body.expiresAt;
    if (raw == null || String(raw).trim() === "") {
      sets.push("expires_at = ?");
      binds.push(null);
    } else {
      const t = Date.parse(String(raw));
      if (Number.isNaN(t)) {
        return c.json({ success: false, error: "Invalid expiry date" }, 400);
      }
      sets.push("expires_at = ?");
      binds.push(new Date(t).toISOString());
    }
  }
  if (sets.length === 0) {
    return c.json({ success: true, data: toPublic(existing) });
  }
  if (textChanged) {
    const retranslated = await translateAnnouncement({
      title: nextTitle,
      body: nextText,
      apiKey: c.env.ANTHROPIC_API_KEY,
    });
    sets.push("translations = ?");
    binds.push(retranslated ? JSON.stringify(retranslated) : null);
  }
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await c.env.DB.prepare(
    `UPDATE announcements SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...binds)
    .run();

  const row = await c.env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?",
  )
    .bind(id)
    .first<AnnouncementRow>();
  return c.json({ success: true, data: row ? toPublic(row) : null });
});

// ============================================================
// POST /:id/remind — re-pop the banner for un-acked users.
// scope=unacked (default): leaves acked rows intact; stamps reminded_at.
// scope=all: wipes acks so the WHOLE roster re-pops from 0-of-N.
// ============================================================
app.post("/:id/remind", requirePermission("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  let scope: "all" | "unacked" = "unacked";
  try {
    const body = (await c.req.json().catch(() => null)) as {
      scope?: unknown;
    } | null;
    if (body && body.scope === "all") scope = "all";
  } catch {
    /* default */
  }

  const rosterRes = await c.env.DB.prepare(
    `SELECT id FROM users WHERE status = 'active'${rosterCompanySql(activeCompanyId(c))}`,
  ).all<{ id: number }>();
  const rosterIds = (rosterRes.results ?? []).map((u) => u.id);
  const ackRes = await c.env.DB.prepare(
    "SELECT user_id FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .all<{ user_id?: number; userId?: number }>();
  const ackedSet = new Set<number>();
  for (const a of ackRes.results ?? []) {
    const uid = a.userId ?? a.user_id;
    if (uid != null) ackedSet.add(uid);
  }
  const unackedCount = rosterIds.filter((uid) => !ackedSet.has(uid)).length;

  if (scope === "all") {
    await c.env.DB.prepare(
      "DELETE FROM announcement_acks WHERE announcement_id = ?",
    )
      .bind(id)
      .run();
  }
  await c.env.DB.prepare(
    "UPDATE announcements SET reminded_at = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), id)
    .run();

  const pendingCount = scope === "all" ? rosterIds.length : unackedCount;
  return c.json({ success: true, pendingCount, scope });
});

// ============================================================
// DELETE /:id — hard delete + clean up ack rows.
// ============================================================
app.delete("/:id", requirePermission("announcements.write"), async (c) => {
  const id = c.req.param("id");
  // Cross-company guard: verify the notice belongs to the active company
  // before touching it (or its ack rows).
  const existing = await getScopedAnnouncement(c, id);
  if (!existing) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM announcements WHERE id = ?")
    .bind(id)
    .run();
  await c.env.DB.prepare(
    "DELETE FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .run();
  return c.json({ success: true });
});

// ============================================================
// POST /:id/ack — record THIS user's ack of one active notice. Idempotent
// (ON CONFLICT DO NOTHING) so a double-tap or retry never errors. Available
// to every authed user — no permission gate.
// ============================================================
app.post("/:id/ack", async (c) => {
  const user = c.get("user");
  if (!user || !user.id) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const id = c.req.param("id");
  const row = await getScopedAnnouncement(c, id);
  if (
    !row ||
    !isActiveFlag(row.isActive ?? row.is_active ?? null) ||
    !notExpired(row.expiresAt ?? row.expires_at ?? null)
  ) {
    return c.json({ success: true, acked: false });
  }
  // Stamp the ack with the NOTICE's company (dual-read: the pg driver
  // camelCases result columns) — conditional so the pre-migration window /
  // D1 test mirror inserts unchanged.
  const annCompanyId = row.companyId ?? row.company_id ?? null;
  const stampCo = annCompanyId != null;
  await c.env.DB.prepare(
    `INSERT INTO announcement_acks (announcement_id, user_id, acked_at${stampCo ? ", company_id" : ""})
     VALUES (?, ?, ?${stampCo ? ", ?" : ""})
     ON CONFLICT (announcement_id, user_id) DO NOTHING`,
  )
    .bind(id, user.id, new Date().toISOString(), ...(stampCo ? [annCompanyId] : []))
    .run();
  return c.json({ success: true, acked: true });
});

// ============================================================
// PUT /:id/attachments/upload?ext=... — two-step upload mirroring the projects
// finance / phase-photos pattern. Returns { r2Key, mime }. The FE then merges
// the manifest entry into the create/patch body.
// ============================================================
app.put(
  "/:id/attachments/upload",
  requirePermission("announcements.write"),
  async (c) => {
    const id = c.req.param("id"); // 'compose' before save; real id on edit
    const ext = (c.req.query("ext") || "jpg").toLowerCase();
    const MIME_BY_EXT: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      heic: "image/heic",
      gif: "image/gif",
      pdf: "application/pdf",
      mp4: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      m4v: "video/x-m4v",
    };
    const mime = MIME_BY_EXT[ext];
    if (!mime) return c.json({ error: "unsupported type" }, 400);
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 25 * 1024 * 1024) {
      return c.json({ error: "Max 25MB" }, 400);
    }
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_") || "compose";
    const key = `announcements/${safeId}/${Date.now()}-${crypto
      .randomUUID()
      .slice(0, 8)}.${ext}`;
    await c.env.POD_BUCKET.put(key, body, {
      httpMetadata: { contentType: mime },
    });
    return c.json({ r2Key: key, mime, size: body.byteLength });
  },
);

// ============================================================
// GET /:id/attachments/:key{.+} — stream the attachment. Permission-gated
// (announcements.read covers every user with banner access; non-readers can't
// hit this). The key includes slashes, hence the {.+} matcher.
// ============================================================
app.get(
  "/:id/attachments/:key{.+}",
  requirePermission("announcements.read"),
  async (c) => {
    const key = c.req.param("key");
    if (!key.startsWith("announcements/")) {
      return c.json({ error: "forbidden key" }, 403);
    }
    const obj = await c.env.POD_BUCKET.get(key);
    if (!obj) return c.json({ error: "Not found" }, 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("Cache-Control", "private, max-age=300");
    return new Response(obj.body, { headers });
  },
);

export default app;
