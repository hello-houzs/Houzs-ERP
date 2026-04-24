import type { Env } from "../types";

// ── Codes ─────────────────────────────────────────────────────
// Format: PRJ-YYYY-NNN (zero-padded 3-digit counter, scoped to the
// project's year). Deliberately brand-neutral so renaming a brand
// or reassigning doesn't invalidate existing codes.

export async function nextProjectCode(env: Env, year: number): Promise<string> {
  const prefix = `PRJ-${year}-`;
  const row = await env.DB.prepare(
    `SELECT code FROM projects
      WHERE code LIKE ?
      ORDER BY code DESC LIMIT 1`
  )
    .bind(`${prefix}%`)
    .first<{ code: string }>();
  let next = 1;
  if (row?.code) {
    const tail = row.code.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `${prefix}${String(next).padStart(3, "0")}`;
}

// ── Activity log ──────────────────────────────────────────────

export async function logProjectActivity(
  env: Env,
  projectId: number,
  action: string,
  fromValue: string | null,
  toValue: string | null,
  note: string | null,
  userId?: number | null
) {
  await env.DB.prepare(
    `INSERT INTO project_activity (project_id, action, from_value, to_value, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(projectId, action, fromValue, toValue, note, userId ?? null)
    .run();
}

// ── Create ────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  event_type_id?: number | null;
  brand?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  venue?: string | null;
  state?: string | null;
  organizer?: string | null;
  notion_url?: string | null;
  pic_id?: number | null;
  created_by: number;
}

export async function createProject(env: Env, input: CreateProjectInput) {
  const now = new Date();
  const year = input.start_date
    ? new Date(input.start_date).getFullYear()
    : now.getFullYear();
  const code = await nextProjectCode(env, year);

  // Default the PIC to the creator so a sales rep who creates their
  // own project immediately sees it under the scoped filter. Admins
  // creating on someone else's behalf can override via input.pic_id.
  const picId = input.pic_id ?? input.created_by ?? null;
  const r = await env.DB.prepare(
    `INSERT INTO projects (
      code, name, stage,
      event_type_id, brand,
      start_date, end_date, venue, state, organizer, notion_url,
      pic_id, created_by
    ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      code,
      input.name,
      input.event_type_id ?? null,
      input.brand ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.venue ?? null,
      input.state ?? null,
      input.organizer ?? null,
      input.notion_url ?? null,
      picId,
      input.created_by
    )
    .run();
  const projectId = r.meta.last_row_id as number;

  // Seed finance row (so 1:1 always exists; UI edits update in place)
  await env.DB.prepare(
    `INSERT INTO project_finance (project_id) VALUES (?)`
  )
    .bind(projectId)
    .run();

  // If event type has a default template, clone its items now.
  if (input.event_type_id) {
    await instantiateChecklistFromEventType(env, projectId, input.event_type_id, input.start_date ?? null);
  }

  await logProjectActivity(env, projectId, "created", null, code, null, input.created_by);

  return { id: projectId, code };
}

// Clone checklist template items into project_checklist, resolving
// due_offset_days against the project's start_date if present.
export async function instantiateChecklistFromEventType(
  env: Env,
  projectId: number,
  eventTypeId: number,
  startDate: string | null
) {
  const et = await env.DB.prepare(
    `SELECT default_template_id FROM project_event_types WHERE id = ?`
  )
    .bind(eventTypeId)
    .first<{ default_template_id: number | null }>();
  const templateId = et?.default_template_id;
  if (!templateId) return;

  const items = await env.DB.prepare(
    `SELECT seq, title, description, required_perm, due_offset_days
       FROM project_checklist_template_items
      WHERE template_id = ?
      ORDER BY seq`
  )
    .bind(templateId)
    .all<{
      seq: number;
      title: string;
      description: string | null;
      required_perm: string | null;
      due_offset_days: number | null;
    }>();

  const rows = items.results ?? [];
  for (const item of rows) {
    const due = resolveDueDate(startDate, item.due_offset_days);
    await env.DB.prepare(
      `INSERT INTO project_checklist
         (project_id, seq, title, description, required_perm, due_date)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        projectId,
        item.seq,
        item.title,
        item.description,
        item.required_perm,
        due
      )
      .run();
  }
}

function resolveDueDate(startDate: string | null, offsetDays: number | null): string | null {
  if (!startDate || offsetDays == null) return null;
  const d = new Date(startDate);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ── Patch ─────────────────────────────────────────────────────

const PATCH_FIELDS = [
  "name", "stage",
  "start_date", "end_date",
  "organizer", "state", "venue", "venue_address",
  "brand", "event_type_id",
  "booth_no", "size_sqm",
  "notion_url", "notes",
  "pic_id",
  // Logistics schedule (Notion parity)
  "setup_start_at", "setup_end_at",
  "dismantle_start_at", "dismantle_end_at",
  "setup_driver_user_id", "setup_lorry_id",
  "dismantle_driver_user_id", "dismantle_lorry_id",
  // Banner
  "banner_message", "banner_tone",
] as const;

// Canonical list of Malaysian states used by the picker.  Kept as a
// JS constant rather than a DB enum so we can add a state without a
// migration. Free-text writes still land (backward-compatible with
// legacy rows), but the UI surfaces this list for new entries.
export const MALAYSIA_STATES = [
  "Kuala Lumpur",
  "Selangor",
  "Johor",
  "Penang",
  "Perak",
  "Pahang",
  "Kedah",
  "Kelantan",
  "Terengganu",
  "Negeri Sembilan",
  "Melaka",
  "Sabah",
  "Sarawak",
  "Putrajaya",
  "Labuan",
] as const;

export const PAYMENT_STATUSES = [
  "not_started",
  "deposit_paid",
  "paid",
  "refund_pending",
  "refunded",
] as const;

export async function patchProject(
  env: Env,
  id: number,
  body: Record<string, any>,
  userId: number
): Promise<boolean> {
  // Capture stage change for activity log before we write.
  let prevStage: string | null = null;
  if ("stage" in body) {
    const row = await env.DB.prepare(
      `SELECT stage FROM projects WHERE id = ?`
    )
      .bind(id)
      .first<{ stage: string }>();
    prevStage = row?.stage ?? null;
  }

  // If start_date moves, bubble the change into checklist due dates
  // for items that were created from a template offset. We don't track
  // which items came from the template, so this only updates items that
  // *already have* a due_date — leaving manually-dated items alone
  // would need a flag we don't have yet, so for v1 we only recompute
  // if the caller explicitly asks via body.__shift_checklist.
  const shiftChecklist = body.__shift_checklist === true;
  let prevStart: string | null = null;
  if (shiftChecklist && "start_date" in body) {
    const row = await env.DB.prepare(
      `SELECT start_date FROM projects WHERE id = ?`
    )
      .bind(id)
      .first<{ start_date: string | null }>();
    prevStart = row?.start_date ?? null;
  }

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(id);

  const r = await env.DB.prepare(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();

  if (prevStage != null && body.stage && prevStage !== body.stage) {
    await logProjectActivity(env, id, "stage_change", prevStage, body.stage, null, userId);
  }

  if (shiftChecklist && prevStart && body.start_date) {
    await shiftChecklistDueDates(env, id, prevStart, body.start_date);
  }

  return r.meta.changes > 0;
}

async function shiftChecklistDueDates(
  env: Env,
  projectId: number,
  prevStart: string,
  nextStart: string
) {
  const prev = new Date(prevStart);
  const next = new Date(nextStart);
  if (isNaN(prev.getTime()) || isNaN(next.getTime())) return;
  const deltaDays = Math.round(
    (next.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (deltaDays === 0) return;
  // SQLite date arithmetic: shift by deltaDays for any non-null due_date
  await env.DB.prepare(
    `UPDATE project_checklist
        SET due_date = date(due_date, ? || ' days'),
            updated_at = datetime('now')
      WHERE project_id = ? AND due_date IS NOT NULL AND status != 'done'`
  )
    .bind(deltaDays >= 0 ? `+${deltaDays}` : `${deltaDays}`, projectId)
    .run();
}

// ── Detail ────────────────────────────────────────────────────

export async function getProjectDetail(env: Env, id: number) {
  const project = await env.DB.prepare(
    `SELECT p.*,
            et.slug  as event_type_slug,
            et.name  as event_type_name,
            u1.name  as created_by_name,
            pic.name as pic_name,
            pic.email as pic_email,
            ud1.name as setup_driver_name,
            ud2.name as dismantle_driver_name,
            l1.plate as setup_lorry_plate,
            l2.plate as dismantle_lorry_plate
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
       LEFT JOIN users u1 ON u1.id = p.created_by
       LEFT JOIN users pic ON pic.id = p.pic_id
       LEFT JOIN users ud1 ON ud1.id = p.setup_driver_user_id
       LEFT JOIN users ud2 ON ud2.id = p.dismantle_driver_user_id
       LEFT JOIN lorries l1 ON l1.id = p.setup_lorry_id
       LEFT JOIN lorries l2 ON l2.id = p.dismantle_lorry_id
      WHERE p.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!project) return null;

  const finance = await env.DB.prepare(
    `SELECT * FROM project_finance WHERE project_id = ?`
  )
    .bind(id)
    .first<any>();

  const checklist = await env.DB.prepare(
    `SELECT c.*, u.name as owner_name, uc.name as completed_by_name
       FROM project_checklist c
       LEFT JOIN users u  ON u.id  = c.owner_user_id
       LEFT JOIN users uc ON uc.id = c.completed_by
      WHERE c.project_id = ?
      ORDER BY c.seq, c.id`
  )
    .bind(id)
    .all();

  const attachments = await env.DB.prepare(
    `SELECT a.*, u.name as uploader_name
       FROM project_attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.project_id = ? AND a.archived_at IS NULL
      ORDER BY a.created_at DESC`
  )
    .bind(id)
    .all();

  const activity = await env.DB.prepare(
    `SELECT act.*, u.name as user_name
       FROM project_activity act
       LEFT JOIN users u ON u.id = act.user_id
      WHERE act.project_id = ? AND act.archived_at IS NULL
      ORDER BY act.created_at DESC
      LIMIT 100`
  )
    .bind(id)
    .all();

  const team = await env.DB.prepare(
    `SELECT t.*, u.name as user_name, u.email as user_email
       FROM project_team t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.project_id = ?
      ORDER BY t.role, u.name`
  )
    .bind(id)
    .all();

  // Linked trips (project_id FK on trips). trips uses trip_no + trip_date
  // + notes — normalize to {code, scheduled_date, description} for the UI.
  const trips = await env.DB.prepare(
    `SELECT id,
            trip_no  as code,
            status,
            trip_date as scheduled_date,
            trip_type,
            notes    as description
       FROM trips
      WHERE project_id = ?
      ORDER BY trip_date DESC, id DESC
      LIMIT 50`
  )
    .bind(id)
    .all();

  // Progress: % of non-NA items marked done. Trip & finance excluded.
  const counts = {
    total: (checklist.results ?? []).length,
    done: (checklist.results ?? []).filter((r: any) => r.status === "done").length,
    na: (checklist.results ?? []).filter((r: any) => r.status === "na").length,
  };
  const denom = counts.total - counts.na;
  const progress_pct = denom > 0 ? Math.round((counts.done / denom) * 100) : 0;

  // Duration (days) — inclusive of both start and end date.
  let duration_days: number | null = null;
  if (project.start_date && project.end_date) {
    const s = new Date(project.start_date);
    const e = new Date(project.end_date);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
      duration_days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
    }
  }

  // Defects — group by phase in the UI. Service returns both phases flat.
  const defects = await env.DB.prepare(
    `SELECT d.*, u.name as reported_by_name, a.assr_no as linked_assr_no
       FROM project_defects d
       LEFT JOIN users u ON u.id = d.reported_by
       LEFT JOIN assr_cases a ON a.id = d.linked_assr_id
      WHERE d.project_id = ? AND d.archived_at IS NULL
      ORDER BY d.phase, d.id DESC`
  )
    .bind(id)
    .all();

  const salesReports = await env.DB.prepare(
    `SELECT sr.*, u.name as uploaded_by_name
       FROM project_sales_reports sr
       LEFT JOIN users u ON u.id = sr.uploaded_by
      WHERE sr.project_id = ? AND sr.archived_at IS NULL
      ORDER BY sr.created_at DESC`
  )
    .bind(id)
    .all();

  // Checklist comments — attached to the item rows client-side via item_id.
  const checklistItemIds = (checklist.results ?? []).map((r: any) => r.id);
  let comments: any[] = [];
  if (checklistItemIds.length) {
    const placeholders = checklistItemIds.map(() => "?").join(",");
    const c = await env.DB.prepare(
      `SELECT cc.*, u.name as user_name
         FROM project_checklist_comments cc
         LEFT JOIN users u ON u.id = cc.user_id
        WHERE cc.item_id IN (${placeholders})
        ORDER BY cc.created_at ASC`
    )
      .bind(...checklistItemIds)
      .all();
    comments = c.results ?? [];
  }

  // Finance ledger lines — the new canonical source. Frontend shows
  // these directly; project_finance is only the cached rollup.
  const ledger = await listLedgerLines(env, id);

  // Stock transfers — OUT + RETURN records, confirmation-tracked.
  const stockTransfers = await env.DB.prepare(
    `SELECT t.*, u.name as created_by_name, uc.name as confirmed_by_name
       FROM project_stock_transfers t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users uc ON uc.id = t.confirmed_by
      WHERE t.project_id = ? AND t.archived_at IS NULL
      ORDER BY t.direction, t.transferred_at DESC, t.id DESC`
  )
    .bind(id)
    .all();

  return {
    project: { ...project, progress_pct, duration_days },
    finance: finance ?? null,
    finance_lines: ledger,
    stock_transfers: stockTransfers.results ?? [],
    checklist: checklist.results ?? [],
    checklist_comments: comments,
    attachments: attachments.results ?? [],
    defects: defects.results ?? [],
    sales_reports: salesReports.results ?? [],
    activity: activity.results ?? [],
    team: team.results ?? [],
    trips: trips.results ?? [],
  };
}

// ── List ──────────────────────────────────────────────────────

export interface ListProjectsFilters {
  stage?: string;
  brand?: string;
  event_type_id?: number;
  search?: string;
  year?: number;
  month?: number;  // 1-12, filters on start_date
  state?: string;
  page?: number;
  per_page?: number;
  include_archived?: boolean;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  /** ACL allow-list. If present, only projects with pic_id IN this list
   *  are returned. Empty array means "nothing" (scoped user with no PIC
   *  in their line → zero results, which is correct). */
  pic_scope?: number[];
}

// Allow-listed sort columns for the project list. The default (when
// sort_by is unset) keeps the "nulls last, newest start_date first"
// behaviour the dashboard relies on.
const PROJECT_SORT_MAP: Record<string, string> = {
  code: "p.code",
  name: "p.name",
  stage: "p.stage",
  brand: "p.brand",
  start_date: "p.start_date",
  end_date: "p.end_date",
  state: "p.state",
  venue: "p.venue",
  booth_no: "p.booth_no",
  size_sqm: "p.size_sqm",
  event_type: "et.name",
  rental: "pf.rental",
  total_sales: "pf.total_sales",
  contractor_cost: "pf.contractor_cost",
  progress_pct: "progress_pct",
};

export async function listProjects(env: Env, f: ListProjectsFilters) {
  const where: string[] = [];
  const binds: any[] = [];
  if (!f.include_archived) where.push("p.archived_at IS NULL");
  if (f.stage) {
    const stages = f.stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (stages.length === 1) {
      where.push("p.stage = ?");
      binds.push(stages[0]);
    } else if (stages.length > 1) {
      where.push(`p.stage IN (${stages.map(() => "?").join(",")})`);
      binds.push(...stages);
    }
  }
  if (f.brand) {
    where.push("p.brand = ?");
    binds.push(f.brand);
  }
  if (f.event_type_id != null) {
    where.push("p.event_type_id = ?");
    binds.push(f.event_type_id);
  }
  if (f.year) {
    where.push("strftime('%Y', p.start_date) = ?");
    binds.push(String(f.year));
  }
  if (f.month && f.month >= 1 && f.month <= 12) {
    where.push("strftime('%m', p.start_date) = ?");
    binds.push(String(f.month).padStart(2, "0"));
  }
  if (f.state) {
    where.push("p.state = ?");
    binds.push(f.state);
  }
  if (f.search) {
    where.push("(p.code LIKE ? OR p.name LIKE ? OR p.venue LIKE ? OR p.organizer LIKE ?)");
    const like = `%${f.search}%`;
    binds.push(like, like, like, like);
  }
  if (f.pic_scope) {
    if (f.pic_scope.length === 0) {
      // Scoped user with no valid PIC line — return no rows.
      where.push("1 = 0");
    } else {
      // Fall back to created_by when pic_id is NULL so legacy projects
      // (pre-migration 039) still attach to their creator's team.
      where.push(
        `COALESCE(p.pic_id, p.created_by) IN (${f.pic_scope.map(() => "?").join(",")})`
      );
      binds.push(...f.pic_scope);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const page = f.page && f.page > 0 ? f.page : 1;
  const perPage = Math.min(f.per_page ?? 50, 200);
  const offset = (page - 1) * perPage;

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM projects p ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  // Build ORDER BY: explicit sort overrides the default; otherwise
  // keep the "nulls last, newest start_date first" behaviour.
  const sortExpr = f.sort_by ? PROJECT_SORT_MAP[f.sort_by] : null;
  const sortDir = f.sort_dir === "asc" ? "ASC" : "DESC";
  const orderBy = sortExpr
    ? `ORDER BY ${sortExpr} ${sortDir}, p.id DESC`
    : `ORDER BY
         CASE WHEN p.start_date IS NULL THEN 1 ELSE 0 END,
         p.start_date DESC, p.id DESC`;

  const rows = await env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.stage, p.brand,
            p.start_date, p.end_date,
            p.state, p.venue, p.booth_no, p.size_sqm,
            p.archived_at,
            p.pic_id, pic.name as pic_name,
            et.name as event_type_name,
            pf.rental, pf.total_sales, pf.contractor_cost,
            -- Computed progress %: done / (total − na). SUM(CASE…) for
            -- D1/SQLite compatibility — avoids the newer FILTER clause.
            (SELECT CASE
                      WHEN SUM(CASE WHEN c.status != 'na' THEN 1 ELSE 0 END) = 0 THEN 0
                      ELSE CAST(
                             100.0 * SUM(CASE WHEN c.status = 'done' THEN 1 ELSE 0 END)
                                   / SUM(CASE WHEN c.status != 'na' THEN 1 ELSE 0 END)
                             AS INTEGER)
                    END
               FROM project_checklist c
              WHERE c.project_id = p.id) as progress_pct
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
       LEFT JOIN project_finance pf ON pf.project_id = p.id
       LEFT JOIN users pic ON pic.id = p.pic_id
     ${whereSql}
     ${orderBy}
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, perPage, offset)
    .all();

  return {
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
  };
}

// ── Finance ───────────────────────────────────────────────────

const FINANCE_FIELDS = [
  "rental", "contractor_cost", "license_fee",
  "deposit_paid", "deposit_refund", "misc_cost",
  "total_sales", "notes",
] as const;

export async function patchFinance(
  env: Env,
  projectId: number,
  body: Record<string, any>,
  userId: number
) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of FINANCE_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')", "updated_by = ?");
  binds.push(userId, projectId);
  const r = await env.DB.prepare(
    `UPDATE project_finance SET ${sets.join(", ")} WHERE project_id = ?`
  )
    .bind(...binds)
    .run();
  await logProjectActivity(env, projectId, "finance_edit", null, null, null, userId);
  return r.meta.changes > 0;
}

// ── Checklist ─────────────────────────────────────────────────

export interface CreateChecklistItemInput {
  project_id: number;
  title: string;
  description?: string | null;
  required_perm?: string | null;
  due_date?: string | null;
  owner_user_id?: number | null;
  seq?: number | null;
}

export async function createChecklistItem(
  env: Env,
  input: CreateChecklistItemInput,
  userId: number
) {
  // Pick the next seq if not provided — append to end.
  let seq = input.seq ?? null;
  if (seq == null) {
    const row = await env.DB.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 10 as next_seq
         FROM project_checklist WHERE project_id = ?`
    )
      .bind(input.project_id)
      .first<{ next_seq: number }>();
    seq = row?.next_seq ?? 10;
  }
  const r = await env.DB.prepare(
    `INSERT INTO project_checklist
       (project_id, seq, title, description, required_perm, due_date, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      seq,
      input.title,
      input.description ?? null,
      input.required_perm ?? null,
      input.due_date ?? null,
      input.owner_user_id ?? null
    )
    .run();
  await logProjectActivity(env, input.project_id, "checklist_add", null, input.title, null, userId);
  return { id: r.meta.last_row_id as number };
}

const CHECKLIST_PATCH_FIELDS = [
  "title", "description", "required_perm",
  "due_date", "owner_user_id", "seq", "notes",
] as const;

export async function patchChecklistItem(
  env: Env,
  itemId: number,
  body: Record<string, any>,
  userId: number
) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of CHECKLIST_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(itemId);
  const r = await env.DB.prepare(
    `UPDATE project_checklist SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

export async function setChecklistStatus(
  env: Env,
  itemId: number,
  status: "pending" | "done" | "na" | "blocked",
  userId: number
) {
  const item = await env.DB.prepare(
    `SELECT project_id, title, status FROM project_checklist WHERE id = ?`
  )
    .bind(itemId)
    .first<{ project_id: number; title: string; status: string }>();
  if (!item) return false;

  if (status === "done") {
    await env.DB.prepare(
      `UPDATE project_checklist
          SET status = 'done',
              completed_by = ?,
              completed_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(userId, itemId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE project_checklist
          SET status = ?,
              completed_by = NULL,
              completed_at = NULL,
              updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(status, itemId)
      .run();
  }

  await logProjectActivity(
    env,
    item.project_id,
    "checklist_status",
    item.status,
    status,
    item.title,
    userId
  );
  return true;
}

// ── Checklist review loop ────────────────────────────────────
// Rejection/amendment flow mirrors what the Notion page captured as
// free-text activity ("Design Reject — reason — Design Amended —
// Design Approved"). Each transition records a row in
// project_checklist_comments so the item has a traceable review
// history.

export async function addChecklistComment(
  env: Env,
  itemId: number,
  kind: "note" | "submit" | "reject" | "amend" | "approve",
  body: string | null,
  userId: number
) {
  const r = await env.DB.prepare(
    `INSERT INTO project_checklist_comments (item_id, kind, body, user_id)
     VALUES (?, ?, ?, ?)`
  )
    .bind(itemId, kind, body ?? null, userId || null)
    .run();
  return { id: r.meta.last_row_id as number };
}

export async function submitChecklistForReview(env: Env, itemId: number, userId: number) {
  await env.DB.prepare(
    `UPDATE project_checklist
        SET review_status = 'pending_review',
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(itemId)
    .run();
  await addChecklistComment(env, itemId, "submit", null, userId);
}

export async function rejectChecklistItem(
  env: Env,
  itemId: number,
  reason: string,
  userId: number
) {
  await env.DB.prepare(
    `UPDATE project_checklist
        SET review_status = 'rejected',
            rejection_reason = ?,
            status = 'pending',
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(reason, itemId)
    .run();
  await addChecklistComment(env, itemId, "reject", reason, userId);
}

export async function amendChecklistItem(env: Env, itemId: number, note: string | null, userId: number) {
  await env.DB.prepare(
    `UPDATE project_checklist
        SET review_status = 'amended',
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(itemId)
    .run();
  await addChecklistComment(env, itemId, "amend", note, userId);
}

export async function approveChecklistItem(env: Env, itemId: number, userId: number) {
  await env.DB.prepare(
    `UPDATE project_checklist
        SET review_status = 'approved',
            status = 'done',
            completed_by = ?,
            completed_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(userId || null, itemId)
    .run();
  await addChecklistComment(env, itemId, "approve", null, userId);
}

// ── Defects ──────────────────────────────────────────────────

export interface CreateDefectInput {
  project_id: number;
  phase: "setup" | "dismantle";
  reported_by_role: "sales" | "logistic";
  item_code?: string | null;
  item_description?: string | null;
  size?: string | null;
  quantity?: number | null;
  reason?: string | null;
  photo_r2_key?: string | null;
}

export async function createDefect(env: Env, input: CreateDefectInput, userId: number) {
  const r = await env.DB.prepare(
    `INSERT INTO project_defects
       (project_id, phase, reported_by_role, item_code, item_description,
        size, quantity, reason, photo_r2_key, reported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.phase,
      input.reported_by_role,
      input.item_code ?? null,
      input.item_description ?? null,
      input.size ?? null,
      input.quantity ?? 1,
      input.reason ?? null,
      input.photo_r2_key ?? null,
      userId || null
    )
    .run();
  await logProjectActivity(
    env,
    input.project_id,
    "defect_add",
    null,
    `${input.phase}/${input.reported_by_role}`,
    input.item_code || input.item_description || null,
    userId
  );
  return { id: r.meta.last_row_id as number };
}

const DEFECT_PATCH_FIELDS = [
  "item_code", "item_description", "size", "quantity",
  "reason", "photo_r2_key", "resolved", "resolved_notes", "linked_assr_id",
] as const;

export async function patchDefect(
  env: Env,
  id: number,
  body: Record<string, any>,
  _userId: number
) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of DEFECT_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  binds.push(id);
  const r = await env.DB.prepare(
    `UPDATE project_defects SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

export async function archiveDefect(env: Env, id: number) {
  await env.DB.prepare(
    `UPDATE project_defects SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
}

// ── Sales reports ────────────────────────────────────────────

export interface CreateSalesReportInput {
  project_id: number;
  title?: string | null;
  sales_amount?: number | null;
  period_start?: string | null;
  period_end?: string | null;
  r2_key?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
}

export async function createSalesReport(
  env: Env,
  input: CreateSalesReportInput,
  userId: number,
  options?: { syncToFinance?: boolean }
) {
  const r = await env.DB.prepare(
    `INSERT INTO project_sales_reports
       (project_id, title, sales_amount, period_start, period_end,
        r2_key, file_name, mime_type, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.title ?? null,
      input.sales_amount ?? null,
      input.period_start ?? null,
      input.period_end ?? null,
      input.r2_key ?? null,
      input.file_name ?? null,
      input.mime_type ?? null,
      userId || null
    )
    .run();

  // Opt-in roll-up into project_finance.total_sales. Summing all
  // non-archived sales_amounts is safer than incrementing — multiple
  // reports can be edited/deleted and we want finance to stay consistent.
  if (options?.syncToFinance) {
    await syncSalesTotalFromReports(env, input.project_id);
  }

  await logProjectActivity(
    env,
    input.project_id,
    "sales_report_add",
    null,
    input.title || String(input.sales_amount ?? ""),
    null,
    userId
  );
  return { id: r.meta.last_row_id as number };
}

export async function archiveSalesReport(env: Env, id: number, syncToFinance?: boolean) {
  const row = await env.DB.prepare(
    `SELECT project_id FROM project_sales_reports WHERE id = ?`
  )
    .bind(id)
    .first<{ project_id: number }>();
  await env.DB.prepare(
    `UPDATE project_sales_reports SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  if (syncToFinance && row?.project_id) {
    await syncSalesTotalFromReports(env, row.project_id);
  }
}

export async function syncSalesTotalFromReports(env: Env, projectId: number) {
  const sum = await env.DB.prepare(
    `SELECT COALESCE(SUM(sales_amount), 0) as total
       FROM project_sales_reports
      WHERE project_id = ? AND archived_at IS NULL`
  )
    .bind(projectId)
    .first<{ total: number }>();
  await env.DB.prepare(
    `UPDATE project_finance
        SET total_sales = ?, updated_at = datetime('now')
      WHERE project_id = ?`
  )
    .bind(sum?.total ?? 0, projectId)
    .run();
}

// ── Finance ledger ───────────────────────────────────────────
// New model: project_finance_lines holds individual income/cost line
// items. project_finance stays as a rollup cache (summed per canonical
// category) so existing list queries keep working. Every ledger write
// triggers a resync.

// Categories the UI surfaces in its picker. Any string is accepted on
// write (forward-compatible with "cleaning fee", "insurance" etc.).
export const LEDGER_COST_CATEGORIES = [
  "rental", "contractor", "license", "deposit", "permit",
  "transport", "accommodation", "staffing", "marketing", "misc",
] as const;

export const LEDGER_INCOME_CATEGORIES = [
  "sales", "deposit_refund", "rebate", "other_income",
] as const;

export interface CreateLedgerLineInput {
  project_id: number;
  kind: "income" | "cost";
  category: string;
  description?: string | null;
  amount: number;
  occurred_at?: string | null;
  r2_key?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  notes?: string | null;
}

export async function createLedgerLine(
  env: Env,
  input: CreateLedgerLineInput,
  userId: number
) {
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error("amount must be a non-negative number");
  }
  if (!input.category.trim()) throw new Error("category required");
  const r = await env.DB.prepare(
    `INSERT INTO project_finance_lines
       (project_id, kind, category, description, amount, occurred_at,
        r2_key, file_name, mime_type, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.kind,
      input.category.trim(),
      input.description ?? null,
      input.amount,
      input.occurred_at ?? null,
      input.r2_key ?? null,
      input.file_name ?? null,
      input.mime_type ?? null,
      input.notes ?? null,
      userId || null
    )
    .run();
  await syncFinanceRollup(env, input.project_id);
  await logProjectActivity(
    env,
    input.project_id,
    "finance_line_add",
    input.kind,
    input.category,
    String(input.amount),
    userId
  );
  return { id: r.meta.last_row_id as number };
}

const LEDGER_LINE_PATCH_FIELDS = [
  "kind", "category", "description", "amount", "occurred_at",
  "r2_key", "file_name", "mime_type", "notes",
] as const;

export async function patchLedgerLine(
  env: Env,
  lineId: number,
  body: Record<string, any>,
  userId: number
) {
  const line = await env.DB.prepare(
    `SELECT project_id FROM project_finance_lines WHERE id = ?`
  )
    .bind(lineId)
    .first<{ project_id: number }>();
  if (!line) return false;

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of LEDGER_LINE_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(lineId);
  await env.DB.prepare(
    `UPDATE project_finance_lines SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  await syncFinanceRollup(env, line.project_id);
  await logProjectActivity(env, line.project_id, "finance_line_edit", null, null, null, userId);
  return true;
}

export async function archiveLedgerLine(env: Env, lineId: number, userId: number) {
  const line = await env.DB.prepare(
    `SELECT project_id FROM project_finance_lines WHERE id = ?`
  )
    .bind(lineId)
    .first<{ project_id: number }>();
  if (!line) return false;
  await env.DB.prepare(
    `UPDATE project_finance_lines SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(lineId)
    .run();
  await syncFinanceRollup(env, line.project_id);
  await logProjectActivity(env, line.project_id, "finance_line_remove", null, null, null, userId);
  return true;
}

// Rebuild project_finance from the current line set. Called after any
// ledger mutation. total_sales stays in sync via this path too — when
// a sales-report line lands, its amount rolls into finance.total_sales.
export async function syncFinanceRollup(env: Env, projectId: number) {
  const sums = await env.DB.prepare(
    `SELECT kind, category, COALESCE(SUM(amount), 0) as total
       FROM project_finance_lines
      WHERE project_id = ? AND archived_at IS NULL
      GROUP BY kind, category`
  )
    .bind(projectId)
    .all<{ kind: string; category: string; total: number }>();

  const out: Record<string, number> = {
    rental: 0,
    contractor_cost: 0,
    license_fee: 0,
    deposit_paid: 0,
    deposit_refund: 0,
    misc_cost: 0,
    total_sales: 0,
  };

  for (const row of sums.results ?? []) {
    if (row.kind === "cost") {
      switch (row.category) {
        case "rental":
          out.rental += row.total;
          break;
        case "contractor":
          out.contractor_cost += row.total;
          break;
        case "license":
          out.license_fee += row.total;
          break;
        case "deposit":
          out.deposit_paid += row.total;
          break;
        default:
          // Everything else bucketed into misc so the rollup stays balanced.
          out.misc_cost += row.total;
      }
    } else if (row.kind === "income") {
      switch (row.category) {
        case "deposit_refund":
          out.deposit_refund += row.total;
          break;
        case "sales":
        case "rebate":
        case "other_income":
          out.total_sales += row.total;
          break;
        default:
          out.total_sales += row.total;
      }
    }
  }

  // Also roll in any project_sales_reports entries — they predate the
  // ledger and users may keep entering sales via that flow.
  const reportSum = await env.DB.prepare(
    `SELECT COALESCE(SUM(sales_amount), 0) as total
       FROM project_sales_reports
      WHERE project_id = ? AND archived_at IS NULL`
  )
    .bind(projectId)
    .first<{ total: number }>();
  // If reports exist, they supersede the "sales" category in lines
  // (which was only seeded from legacy total_sales as a historical anchor).
  // Otherwise fall back to the ledger-derived sum.
  const reportTotal = reportSum?.total ?? 0;
  if (reportTotal > 0) {
    // Keep the larger of the two — a defensive max avoids double-counting
    // during the window where an admin is transitioning from reports
    // into ledger entries.
    out.total_sales = Math.max(out.total_sales, reportTotal);
  }

  await env.DB.prepare(
    `UPDATE project_finance
        SET rental = ?, contractor_cost = ?, license_fee = ?,
            deposit_paid = ?, deposit_refund = ?, misc_cost = ?,
            total_sales = ?, updated_at = datetime('now')
      WHERE project_id = ?`
  )
    .bind(
      out.rental,
      out.contractor_cost,
      out.license_fee,
      out.deposit_paid,
      out.deposit_refund,
      out.misc_cost,
      out.total_sales,
      projectId
    )
    .run();
}

// ── Payment workflow ─────────────────────────────────────────
// Dedicated from finance ledger because "did we pay the organizer"
// is a different question from "what did it cost". A case can have
// a full ledger and still be blocked because the security deposit
// payment isn't recorded yet.

export async function setPaymentStatus(
  env: Env,
  projectId: number,
  status: string,
  opts: { notes?: string | null; proof_r2_key?: string | null; proof_file_name?: string | null },
  userId: number
) {
  if (!PAYMENT_STATUSES.includes(status as any)) {
    throw new Error(`Invalid payment_status: ${status}`);
  }
  const sets: string[] = [
    "payment_status = ?",
    "payment_updated_at = datetime('now')",
    "payment_updated_by = ?",
  ];
  const binds: any[] = [status, userId || null];
  if (opts.notes !== undefined) {
    sets.push("payment_notes = ?");
    binds.push(opts.notes ?? null);
  }
  if (opts.proof_r2_key !== undefined) {
    sets.push("payment_proof_r2_key = ?");
    binds.push(opts.proof_r2_key ?? null);
  }
  if (opts.proof_file_name !== undefined) {
    sets.push("payment_proof_file_name = ?");
    binds.push(opts.proof_file_name ?? null);
  }
  binds.push(projectId);
  await env.DB.prepare(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  await logProjectActivity(env, projectId, "payment_status", null, status, opts.notes ?? null, userId);
}

// ── Stock transfers ──────────────────────────────────────────

export interface CreateStockTransferInput {
  project_id: number;
  direction: "out" | "return";
  transferred_at?: string | null;
  record_r2_key?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  notes?: string | null;
}

export async function createStockTransfer(
  env: Env,
  input: CreateStockTransferInput,
  userId: number
) {
  const r = await env.DB.prepare(
    `INSERT INTO project_stock_transfers
       (project_id, direction, transferred_at, record_r2_key, file_name, mime_type, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.direction,
      input.transferred_at ?? null,
      input.record_r2_key ?? null,
      input.file_name ?? null,
      input.mime_type ?? null,
      input.notes ?? null,
      userId || null
    )
    .run();
  await logProjectActivity(
    env,
    input.project_id,
    "stock_transfer_add",
    null,
    input.direction,
    input.notes ?? null,
    userId
  );
  return { id: r.meta.last_row_id as number };
}

export async function confirmStockTransfer(env: Env, transferId: number, userId: number) {
  const row = await env.DB.prepare(
    `SELECT project_id, direction FROM project_stock_transfers WHERE id = ?`
  )
    .bind(transferId)
    .first<{ project_id: number; direction: string }>();
  if (!row) return false;
  await env.DB.prepare(
    `UPDATE project_stock_transfers
        SET confirmed_at = datetime('now'), confirmed_by = ?
      WHERE id = ?`
  )
    .bind(userId || null, transferId)
    .run();
  await logProjectActivity(
    env,
    row.project_id,
    "stock_transfer_confirm",
    null,
    row.direction,
    null,
    userId
  );
  return true;
}

export async function unconfirmStockTransfer(env: Env, transferId: number) {
  await env.DB.prepare(
    `UPDATE project_stock_transfers
        SET confirmed_at = NULL, confirmed_by = NULL
      WHERE id = ?`
  )
    .bind(transferId)
    .run();
}

export async function archiveStockTransfer(env: Env, transferId: number) {
  await env.DB.prepare(
    `UPDATE project_stock_transfers SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(transferId)
    .run();
}

// ── Internal (existing) ──────────────────────────────────────

export async function listLedgerLines(env: Env, projectId: number) {
  const rows = await env.DB.prepare(
    `SELECT l.*, u.name as created_by_name
       FROM project_finance_lines l
       LEFT JOIN users u ON u.id = l.created_by
      WHERE l.project_id = ? AND l.archived_at IS NULL
      ORDER BY
        CASE WHEN l.occurred_at IS NULL THEN 1 ELSE 0 END,
        l.occurred_at DESC,
        l.id DESC`
  )
    .bind(projectId)
    .all();
  return rows.results ?? [];
}

export async function deleteChecklistItem(env: Env, itemId: number, userId: number) {
  const item = await env.DB.prepare(
    `SELECT project_id, title FROM project_checklist WHERE id = ?`
  )
    .bind(itemId)
    .first<{ project_id: number; title: string }>();
  if (!item) return false;
  await env.DB.prepare(`DELETE FROM project_checklist WHERE id = ?`).bind(itemId).run();
  await logProjectActivity(env, item.project_id, "checklist_remove", item.title, null, null, userId);
  return true;
}
