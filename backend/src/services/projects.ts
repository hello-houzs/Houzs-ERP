import type { Env } from "../types";
import { recomputeAutoCostLines } from "./projectCostRates";
import { scopeNotExpiredSql } from "./projectAcl";

// ── Codes ─────────────────────────────────────────────────────
// Format: `YYYY-MM-{ORGANIZER}-{STATE}-{VENUE}-{BRAND}` — built from
// the project's identity fields so the code itself describes the
// event. Organizer defaults to `SOLO` when null (mirrors the
// canonical name format). State / venue / brand are required;
// createProject throws if any are missing. On collision (two
// projects with identical inputs and dates) `-2`, `-3` … suffixes
// are appended.
//
// Migration 071 backfilled names to this same family; the
// backfill-project-codes.mjs script rewrites legacy `PRJ-YYYY-NNN`
// rows to the new format in one pass.

function slugSegment(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function deriveProjectCode(input: {
  year: number;
  month: number;
  organizer?: string | null;
  state?: string | null;
  venue?: string | null;
  brand?: string | null;
  /** Optional event-type slug. When "solo", the organizer slot is
   *  forced to the literal "SOLO" regardless of whether an organizer
   *  was picked — a solo event is by definition not organised by
   *  anyone. Mirrors `composeDefaultProjectName` on the frontend. */
  event_type_slug?: string | null;
}): string {
  const state = slugSegment(input.state);
  const venue = slugSegment(input.venue);
  const brand = slugSegment(input.brand);
  if (!state) throw new Error("state is required to generate a project code");
  if (!venue) throw new Error("venue is required to generate a project code");
  if (!brand) throw new Error("brand is required to generate a project code");
  const isSolo = (input.event_type_slug || "").toLowerCase() === "solo";
  const organizer = isSolo ? "SOLO" : (slugSegment(input.organizer) || "SOLO");
  const yyyy = String(input.year);
  const mm = String(input.month).padStart(2, "0");
  return `${yyyy}-${mm}-${organizer}-${state}-${venue}-${brand}`;
}

/** Disambiguate against existing codes by appending -2, -3, … */
export async function uniqueProjectCode(env: Env, base: string): Promise<string> {
  // Avoid LIKE here — D1's pattern-complexity guard has been observed
  // to reject even short LIKE patterns ("LIKE or GLOB pattern too
  // complex"), and a plain prefix comparison via substr() is both
  // immune to that and indexable.
  const prefix = `${base}-`;
  const rows = await env.DB.prepare(
    `SELECT code FROM projects
      WHERE code = ?1
         OR (length(code) > ?2 AND substr(code, 1, ?2) = ?3)`
  )
    .bind(base, prefix.length, prefix)
    .all<{ code: string }>();
  const used = new Set((rows.results ?? []).map((r) => r.code));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
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

// ── Crew membership ───────────────────────────────────────────
// Returns the phase(s) on which `userId` is crewed for `projectId`.
// Empty array = not on the crew. Used by the Driver App project
// endpoints (row-level gate) and by the phase-photo upload guard so
// a setup-only helper can't upload to dismantle.
export async function getUserPhasesOnProject(
  env: Env,
  projectId: number,
  userId: number
): Promise<Array<"setup" | "dismantle">> {
  if (!userId) return [];
  const row = await env.DB.prepare(
    `SELECT setup_driver_user_id, setup_helper_1_id, setup_helper_2_id,
            dismantle_driver_user_id, dismantle_helper_1_id, dismantle_helper_2_id
       FROM projects WHERE id = ?`
  )
    .bind(projectId)
    .first<{
      setup_driver_user_id: number | null;
      setup_helper_1_id: number | null;
      setup_helper_2_id: number | null;
      dismantle_driver_user_id: number | null;
      dismantle_helper_1_id: number | null;
      dismantle_helper_2_id: number | null;
    }>();
  if (!row) return [];
  const phases: Array<"setup" | "dismantle"> = [];
  if (
    row.setup_driver_user_id === userId ||
    row.setup_helper_1_id === userId ||
    row.setup_helper_2_id === userId
  ) {
    phases.push("setup");
  }
  if (
    row.dismantle_driver_user_id === userId ||
    row.dismantle_helper_1_id === userId ||
    row.dismantle_helper_2_id === userId
  ) {
    phases.push("dismantle");
  }
  return phases;
}

// ── Auto-derived name ─────────────────────────────────────────
// Canonical project name format. Used by both createProject() and the
// seed script so a future re-seed lands at the exact same string as
// the backfill migration 071.
//
//   {state} [{brand}] {organizer | SOLO} @ {venue}
//
// Examples:
//   JOHOR [AKEMI] KAI HAO (KL CHEN) @ PARADIGM MALL
//   SABAH [AKEMI] SOLO @ SURIA SABAH   (organizer NULL → "SOLO")
export function deriveProjectName(input: {
  state?: string | null;
  brand?: string | null;
  organizer?: string | null;
  venue?: string | null;
  /** Optional event-type slug. When "solo", the organizer slot is
   *  forced to the literal "SOLO" regardless of organizer input. */
  event_type_slug?: string | null;
}): string {
  const state = (input.state || "").trim() || "—";
  const brand = (input.brand || "").trim() || "—";
  const venue = (input.venue || "").trim() || "—";
  const isSolo = (input.event_type_slug || "").toLowerCase() === "solo";
  const organizer = isSolo
    ? "SOLO"
    : ((input.organizer || "").trim() || "SOLO");
  return `${state} [${brand}] ${organizer} @ ${venue}`;
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
  if (input.start_date && input.end_date && input.end_date < input.start_date) {
    throw new Error("end_date must be on or after start_date");
  }
  const now = new Date();
  const anchor = input.start_date ? new Date(input.start_date) : now;
  const year = anchor.getFullYear();
  const month = anchor.getMonth() + 1;
  // Resolve event-type slug from the id so the derive helpers can
  // force the organizer slot to "SOLO" for solo events (matches the
  // frontend's auto-fill). Missing or unknown ids fall through as
  // null — derive helpers treat that as a non-solo event.
  let eventTypeSlug: string | null = null;
  if (input.event_type_id != null) {
    const et = await env.DB.prepare(
      `SELECT slug FROM project_event_types WHERE id = ?`
    )
      .bind(input.event_type_id)
      .first<{ slug: string | null }>();
    eventTypeSlug = et?.slug ?? null;
  }
  // Derive code from identity fields. Throws if state/venue/brand are
  // missing; route layer converts to a 400. Organizer null OR
  // event_type=solo → "SOLO".
  const baseCode = deriveProjectCode({
    year,
    month,
    organizer: input.organizer,
    state: input.state,
    venue: input.venue,
    brand: input.brand,
    event_type_slug: eventTypeSlug,
  });
  const code = await uniqueProjectCode(env, baseCode);

  // Default the PIC to the creator so a sales rep who creates their
  // own project immediately sees it under the scoped filter. Admins
  // creating on someone else's behalf can override via input.pic_id.
  const picId = input.pic_id ?? input.created_by ?? null;
  // Auto-derive name when caller doesn't supply one. Keeps the "+ New
  // Project" form simple — boss just picks state/brand/organizer/venue.
  const name =
    input.name?.trim() ||
    deriveProjectName({
      state: input.state,
      brand: input.brand,
      organizer: input.organizer,
      venue: input.venue,
      event_type_slug: eventTypeSlug,
    });
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
      name,
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
//
// Mig 050: template sections are cloned to per-project sections first,
// then template_items.section_id is mapped to the new project section
// id when inserting tasks. Template items with `requires_review = 1`
// translate to `required_perm = 'projects.approve'` on the cloned task,
// reusing the existing review pipeline (mig 024).
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

  // 1. Clone sections, keeping a map from template section id → new
  //    project section id so we can translate item.section_id below.
  const tplSections = await env.DB.prepare(
    `SELECT id, name, sort_order, display_mode
       FROM project_checklist_template_sections
      WHERE template_id = ?
      ORDER BY sort_order, id`
  )
    .bind(templateId)
    .all<{ id: number; name: string; sort_order: number; display_mode: string | null }>();

  const sectionIdMap = new Map<number, number>();
  for (const s of tplSections.results ?? []) {
    const ins = await env.DB.prepare(
      `INSERT INTO project_checklist_sections (project_id, name, sort_order, display_mode)
       VALUES (?, ?, ?, ?)`
    )
      .bind(projectId, s.name, s.sort_order, s.display_mode || "list")
      .run();
    sectionIdMap.set(s.id, ins.meta.last_row_id as number);
  }

  // 2. Clone items. requires_review = 1 → required_perm = projects.approve
  //    (unless the template already specifies a custom perm). Section_id
  //    maps via sectionIdMap; unmapped sections fall through as null.
  const items = await env.DB.prepare(
    `SELECT seq, title, description, required_perm, role_label, crew_visible,
            due_offset_days, section_id, requires_review, pill_kind, pill_value
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
      role_label: string | null;
      crew_visible: number | null;
      due_offset_days: number | null;
      section_id: number | null;
      requires_review: number | null;
      pill_kind: string | null;
      pill_value: string | null;
    }>();

  const rows = items.results ?? [];
  for (const item of rows) {
    const due = resolveDueDate(startDate, item.due_offset_days);
    const projectSectionId = item.section_id
      ? sectionIdMap.get(item.section_id) ?? null
      : null;
    const requiredPerm =
      item.required_perm ??
      (item.requires_review ? "projects.approve" : null);
    await env.DB.prepare(
      `INSERT INTO project_checklist
         (project_id, section_id, seq, title, description, required_perm,
          role_label, crew_visible, due_date, due_offset_days, status, pill_kind, pill_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        projectId,
        projectSectionId,
        item.seq,
        item.title,
        item.description,
        requiredPerm,
        item.role_label,
        item.crew_visible ? 1 : 0,
        due,
        item.due_offset_days,
        // Pill rows (payment/deposit) never count toward checklist
        // progress, so they clone in as 'na'.
        item.pill_kind ? "na" : "pending",
        item.pill_kind,
        item.pill_value
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
  "name", "stage", "status",
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
  // Phase helper crew (mig 083) — mirrors trips.helper_1_id / helper_2_id /
  // helper_outsourced per phase so the trip-link auto-copy can fill the
  // trip's empty crew slots from the project's planned crew.
  "setup_helper_1_id", "setup_helper_2_id", "setup_helper_outsourced",
  "dismantle_helper_1_id", "dismantle_helper_2_id", "dismantle_helper_outsourced",
  // Banner
  "banner_message", "banner_tone",
] as const;

// Canonical list of Malaysian states used by the picker.  Kept as a
// JS constant rather than a DB enum so we can add a state without a
// migration. Free-text writes still land (backward-compatible with
// legacy rows), but the UI surfaces this list for new entries.
// 13 negeri + 3 federal territories (Wilayah Persekutuan) — ALL CAPS
// to match the canonical form used across the data. Cities (IPOH,
// SEREMBAN, KUANTAN, etc.) get rolled up to their state at write
// time and during data backfills.
export const MALAYSIA_STATES = [
  "JOHOR",
  "KEDAH",
  "KELANTAN",
  "KL",
  "LABUAN",
  "MELAKA",
  "NEGERI SEMBILAN",
  "PAHANG",
  "PENANG",
  "PERAK",
  "PERLIS",
  "PUTRAJAYA",
  "SABAH",
  "SARAWAK",
  "SELANGOR",
  "TERENGGANU",
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
): Promise<{ ok: boolean; shifted_tasks: number; delta_days: number }> {
  // Capture current stage + start_date in one read so we can both log the
  // stage transition and shift checklist due_dates by the start_date delta
  // without a second SELECT.
  const wantStageOrDate =
    "stage" in body || "start_date" in body || "end_date" in body;
  let prevStage: string | null = null;
  let prevStart: string | null = null;
  let prevEnd: string | null = null;
  if (wantStageOrDate) {
    const row = await env.DB.prepare(
      `SELECT stage, start_date, end_date FROM projects WHERE id = ?`
    )
      .bind(id)
      .first<{
        stage: string;
        start_date: string | null;
        end_date: string | null;
      }>();
    prevStage = row?.stage ?? null;
    prevStart = row?.start_date ?? null;
    prevEnd = row?.end_date ?? null;
  }

  // end_date >= start_date when both are set after the patch.
  const nextStart =
    "start_date" in body ? (body.start_date as string | null) : prevStart;
  const nextEnd =
    "end_date" in body ? (body.end_date as string | null) : prevEnd;
  if (nextStart && nextEnd && nextEnd < nextStart) {
    throw new Error("end_date must be on or after start_date");
  }

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return { ok: false, shifted_tasks: 0, delta_days: 0 };
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

  // Re-derive checklist due_dates from the new start_date and each
  // task's due_offset_days (the offset configured in Project
  // Maintenance, persisted onto the row at template-instantiation
  // time and on every manual due_date edit). Stock-transfer mirror
  // tasks (notes LIKE 'auto:%') are skipped — their due_date follows
  // the transferred_at field, not the project schedule.
  let shifted = 0;
  let deltaDays = 0;
  if (
    "start_date" in body &&
    body.start_date &&
    prevStart !== body.start_date
  ) {
    const out = await redateChecklistFromOffsets(
      env,
      id,
      body.start_date as string
    );
    shifted = out.shifted;
    deltaDays = out.deltaDays;
  }

  return {
    ok: r.meta.changes > 0,
    shifted_tasks: shifted,
    delta_days: deltaDays,
  };
}

async function redateChecklistFromOffsets(
  env: Env,
  projectId: number,
  nextStart: string
): Promise<{ shifted: number; deltaDays: number }> {
  // Normalise to YYYY-MM-DD so the SQLite `date(...)` builtin gets a
  // clean anchor regardless of any stray time/zone bits a legacy row
  // might carry.
  const nextDay = String(nextStart).slice(0, 10);
  if (isNaN(new Date(nextDay + "T00:00:00Z").getTime())) {
    return { shifted: 0, deltaDays: 0 };
  }
  // For each task with a known offset, due_date = nextDay + offset.
  // Skip auto-mirror rows (notes='auto:stock_transfer=<id>' etc.) and
  // already-completed work — completed tasks keep their original due
  // date for audit. Manual tasks without an offset are left alone.
  const r = await env.DB.prepare(
    `UPDATE project_checklist
        SET due_date = date(?, due_offset_days || ' days'),
            updated_at = datetime('now')
      WHERE project_id = ?
        AND due_offset_days IS NOT NULL
        AND status != 'done'
        AND (notes IS NULL OR notes NOT LIKE 'auto:%')`
  )
    .bind(nextDay, projectId)
    .run();
  const shifted = r.meta.changes ?? 0;
  console.log(
    `[redateChecklistFromOffsets] project=${projectId} anchor=${nextDay} shifted=${shifted}`
  );
  // deltaDays kept on the return for the toast — leave at 0 since
  // we re-derive absolute dates rather than applying a single delta.
  return { shifted, deltaDays: 0 };
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
            l2.plate as dismantle_lorry_plate,
            uhs1.name as setup_helper_1_name,
            uhs2.name as setup_helper_2_name,
            uhd1.name as dismantle_helper_1_name,
            uhd2.name as dismantle_helper_2_name
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
       LEFT JOIN users u1 ON u1.id = p.created_by
       LEFT JOIN users pic ON pic.id = p.pic_id
       LEFT JOIN users ud1 ON ud1.id = p.setup_driver_user_id
       LEFT JOIN users ud2 ON ud2.id = p.dismantle_driver_user_id
       LEFT JOIN users uhs1 ON uhs1.id = p.setup_helper_1_id
       LEFT JOIN users uhs2 ON uhs2.id = p.setup_helper_2_id
       LEFT JOIN users uhd1 ON uhd1.id = p.dismantle_helper_1_id
       LEFT JOIN users uhd2 ON uhd2.id = p.dismantle_helper_2_id
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

  // Sections (mig 050) — ordered by sort_order. Tasks reference these
  // by section_id; tasks with section_id IS NULL render as
  // "Uncategorised" on the frontend.
  const sections = await env.DB.prepare(
    `SELECT id, name, sort_order, display_mode, created_at
       FROM project_checklist_sections
      WHERE project_id = ?
      ORDER BY sort_order, id`
  )
    .bind(id)
    .all();

  // Per-task attachments (mig 050) — replaces the project-level
  // Attachments panel. Attached to tasks by item_id.
  const checklistItemIdsRaw = (checklist.results ?? []).map((r: any) => r.id);
  let taskAttachments: any[] = [];
  if (checklistItemIdsRaw.length) {
    const placeholders = checklistItemIdsRaw.map(() => "?").join(",");
    const a = await env.DB.prepare(
      `SELECT att.*, u.name as uploader_name
         FROM project_checklist_attachments att
         LEFT JOIN users u ON u.id = att.uploaded_by
        WHERE att.item_id IN (${placeholders}) AND att.archived_at IS NULL
        ORDER BY att.uploaded_at DESC, att.id DESC`
    )
      .bind(...checklistItemIdsRaw)
      .all();
    taskAttachments = a.results ?? [];
  }

  // Project-level attachments — kept for legacy data. The UI panel was
  // removed in mig 050; this stays in the response so any old client
  // doesn't 500 on a missing field.
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

  // Sales entries surface as virtual income rows in the ledger so the
  // Finance section reflects rep-entered sales without double-bookkeeping.
  // sales_entries is the source of truth (managed via the Sales section);
  // these synthetic rows carry source='sales_entry' so the UI suppresses
  // edit/delete controls.
  const salesEntryLines = await env.DB.prepare(
    `SELECT s.id, s.amount, s.occurred_at, s.created_at,
            s.customer_name, s.ref_no, s.notes,
            COALESCE(sp.name, u.name) as created_by_name
       FROM sales_entries s
       LEFT JOIN users u  ON u.id  = s.created_by
       LEFT JOIN users sp ON sp.id = s.sales_person_id
      WHERE s.project_id = ?
        AND s.archived_at IS NULL
        AND s.status != 'void'
      ORDER BY s.occurred_at DESC, s.id DESC`
  )
    .bind(id)
    .all<{
      id: number;
      amount: number;
      occurred_at: string;
      created_at: string;
      customer_name: string;
      ref_no: string | null;
      notes: string | null;
      created_by_name: string | null;
    }>();
  // Quick-log rows (rep entered amount + ref_no only at the project)
  // carry the sentinel "(quick log)" in customer_name. Render them
  // with a friendlier "Quick log · {ref}" label in the project finance
  // ledger so the boss isn't squinting at a parenthesised placeholder.
  const QUICK_LOG_SENTINEL = "(quick log)";
  const synthIncome = (salesEntryLines.results ?? []).map((s) => ({
    id: -s.id,
    project_id: id,
    kind: "income" as const,
    category: "sales",
    description:
      s.customer_name === QUICK_LOG_SENTINEL
        ? `Quick log · ${s.ref_no ?? "no ref"}`
        : (s.ref_no ? `${s.ref_no} · ` : "") + s.customer_name,
    amount: s.amount,
    occurred_at: s.occurred_at,
    r2_key: null,
    file_name: null,
    mime_type: null,
    notes: s.notes,
    created_by_name: s.created_by_name,
    created_at: s.created_at,
    archived_at: null,
    source: "sales_entry" as const,
    source_id: s.id,
  }));
  const ledgerWithSales = [...ledger, ...synthIncome].sort((a: any, b: any) => {
    const ao = a.occurred_at ?? "";
    const bo = b.occurred_at ?? "";
    if (ao && bo) return bo.localeCompare(ao);
    if (!ao && bo) return 1;
    if (ao && !bo) return -1;
    return (b.id ?? 0) - (a.id ?? 0);
  });

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

  // Stage progress (mig 050) — one entry per section with done /
  // total / na counts. The UI replaces the percentage bar with this.
  // Sections that don't have any tasks yet are still returned (count
  // 0) so admins see them as empty stages.
  const sectionList = (sections.results ?? []) as Array<{
    id: number;
    name: string;
    sort_order: number;
  }>;
  const sectionProgress = sectionList.map((s) => {
    const items = (checklist.results ?? []).filter(
      (r: any) => r.section_id === s.id
    );
    const total = items.length;
    const done = items.filter((r: any) => r.status === "done").length;
    const na = items.filter((r: any) => r.status === "na").length;
    const denom = total - na;
    const complete = denom > 0 && done === denom;
    return {
      ...s,
      total,
      done,
      na,
      complete: complete ? 1 : 0,
    };
  });
  // Uncategorised bucket — tasks without a section_id.
  const uncatItems = (checklist.results ?? []).filter(
    (r: any) => r.section_id == null
  );
  if (uncatItems.length > 0) {
    const total = uncatItems.length;
    const done = uncatItems.filter((r: any) => r.status === "done").length;
    const na = uncatItems.filter((r: any) => r.status === "na").length;
    const denom = total - na;
    sectionProgress.push({
      id: 0,
      name: "Uncategorised",
      sort_order: 9999,
      total,
      done,
      na,
      complete: denom > 0 && done === denom ? 1 : 0,
    });
  }

  // Sales attendees (mig 087) — reps physically attending the project.
  // Reading from the sales_reps master so we can show code + name + the
  // user-name fallback when the rep has a workspace login.
  const salesAttendees = await env.DB.prepare(
    `SELECT a.sales_rep_id, a.created_at,
            r.code      as rep_code,
            r.name      as rep_name,
            r.user_id   as rep_user_id,
            u.name      as user_name
       FROM project_sales_attendees a
       LEFT JOIN sales_reps r ON r.id = a.sales_rep_id
       LEFT JOIN users u      ON u.id = r.user_id
      WHERE a.project_id = ?
      ORDER BY r.code, r.name`
  )
    .bind(id)
    .all();

  return {
    project: { ...project, progress_pct, duration_days },
    finance: finance ?? null,
    finance_lines: ledgerWithSales,
    stock_transfers: stockTransfers.results ?? [],
    checklist: checklist.results ?? [],
    checklist_comments: comments,
    checklist_attachments: taskAttachments,
    sections: sectionList,
    section_progress: sectionProgress,
    attachments: attachments.results ?? [],
    defects: defects.results ?? [],
    sales_reports: salesReports.results ?? [],
    sales_attendees: salesAttendees.results ?? [],
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
  /** Active tasklist section name (mig 050). When set, the list only
   *  returns projects whose lowest-sort_order section with open tasks
   *  matches. Special values: "__done" = all sections complete; "__none"
   *  = project has no sections defined. */
  section?: string;
  /** When true, drop projects whose every section is complete (the
   *  same predicate `section === "__done"` matches positively). Used
   *  by the list page's "Hide completed" toggle. Independent of
   *  `section` — if the section filter is `__done`, this is ignored
   *  so the user can explicitly view the completed bucket. */
  exclude_done?: boolean;
  page?: number;
  per_page?: number;
  include_archived?: boolean;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  /** ACL allow-list. If present, only projects with pic_id IN this list
   *  are returned. Empty array means "nothing" (scoped user with no PIC
   *  in their line → zero results, which is correct). */
  pic_scope?: number[];
  /** Brand allow-list — paired with pic_scope for sales-dept scoping
   *  (migration 048). Empty array means the scoped user has no brand
   *  coverage → zero results. Undefined means no brand ACL applies. */
  brand_scope?: string[];
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
  pic_name: "pic.name",
  created_by_name: "cb.name",
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
  // "Completed project" predicate — reused by both the positive
  // (section=__done) filter and the negative (exclude_done) toggle.
  const SECTION_DONE_PREDICATE = `(
    EXISTS (SELECT 1 FROM project_checklist_sections s WHERE s.project_id = p.id)
    AND NOT EXISTS (
      SELECT 1 FROM project_checklist_sections s
       WHERE s.project_id = p.id
         AND EXISTS (
           SELECT 1 FROM project_checklist c
            WHERE c.project_id = p.id
              AND c.section_id = s.id
              AND c.status NOT IN ('done','na')
         )
    )
  )`;

  if (f.exclude_done && f.section !== "__done") {
    where.push(`NOT ${SECTION_DONE_PREDICATE}`);
  }

  if (f.section) {
    if (f.section === "__done") {
      where.push(SECTION_DONE_PREDICATE);
    } else if (f.section === "__none") {
      where.push(
        `NOT EXISTS (SELECT 1 FROM project_checklist_sections s WHERE s.project_id = p.id)`
      );
    } else {
      // Match the active section (lowest sort_order with open tasks).
      where.push(
        `(
           SELECT s.name FROM project_checklist_sections s
            WHERE s.project_id = p.id
              AND EXISTS (
                SELECT 1 FROM project_checklist c
                 WHERE c.project_id = p.id
                   AND c.section_id = s.id
                   AND c.status NOT IN ('done','na')
              )
            ORDER BY s.sort_order LIMIT 1
         ) = ?`
      );
      binds.push(f.section);
    }
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
      // PIC visibility expires PIC_GRACE_DAYS after the project ends (owner:
      // "完了的四天之后"). Only scoped users (pic_scope set) get this filter.
      where.push(scopeNotExpiredSql);
    }
  }
  if (f.brand_scope) {
    if (f.brand_scope.length === 0) {
      // Scoped user with no brand coverage — return no rows.
      where.push("1 = 0");
    } else {
      // Project must have a brand AND it must be in the user's
      // department's allow-list. Brand-less projects are intentionally
      // invisible to scoped users — admins fix by setting the brand.
      where.push(
        `(p.brand IS NOT NULL AND p.brand IN (${f.brand_scope.map(() => "?").join(",")}))`
      );
      binds.push(...f.brand_scope);
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
    `SELECT p.id, p.code, p.name, p.stage, p.status, p.brand,
            p.start_date, p.end_date,
            p.state, p.venue, p.booth_no, p.size_sqm,
            p.archived_at,
            p.pic_id, pic.name as pic_name,
            p.created_by, cb.name as created_by_name,
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
              WHERE c.project_id = p.id) as progress_pct,
            -- Section-driven stage tracker (mig 050).
            -- active_section = lowest-sort_order section with any open task.
            (SELECT s.name FROM project_checklist_sections s
              WHERE s.project_id = p.id
                AND EXISTS (
                  SELECT 1 FROM project_checklist c
                   WHERE c.project_id = p.id
                     AND c.section_id = s.id
                     AND c.status NOT IN ('done', 'na')
                )
              ORDER BY s.sort_order LIMIT 1) as active_section_name,
            -- Section totals so the UI can show "complete" when all are done.
            (SELECT COUNT(*) FROM project_checklist_sections s
              WHERE s.project_id = p.id) as sections_total,
            (SELECT COUNT(*) FROM project_checklist_sections s
              WHERE s.project_id = p.id
                AND NOT EXISTS (
                  SELECT 1 FROM project_checklist c
                   WHERE c.project_id = p.id
                     AND c.section_id = s.id
                     AND c.status NOT IN ('done', 'na')
                )) as sections_complete
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
       LEFT JOIN project_finance pf ON pf.project_id = p.id
       LEFT JOIN users pic ON pic.id = p.pic_id
       LEFT JOIN users cb ON cb.id = p.created_by
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
  section_id?: number | null;
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
  // Compute the offset relative to the project's start_date, so a
  // later project-level start_date change keeps this task at the
  // same relative position in the schedule.
  let dueOffsetDays: number | null = null;
  if (input.due_date) {
    const proj = await env.DB.prepare(
      `SELECT start_date FROM projects WHERE id = ?`
    )
      .bind(input.project_id)
      .first<{ start_date: string | null }>();
    if (proj?.start_date) {
      const due = new Date(String(input.due_date).slice(0, 10) + "T00:00:00Z");
      const start = new Date(String(proj.start_date).slice(0, 10) + "T00:00:00Z");
      if (!isNaN(due.getTime()) && !isNaN(start.getTime())) {
        dueOffsetDays = Math.round(
          (due.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
      }
    }
  }
  const r = await env.DB.prepare(
    `INSERT INTO project_checklist
       (project_id, section_id, seq, title, description, required_perm, due_date, due_offset_days, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.section_id ?? null,
      seq,
      input.title,
      input.description ?? null,
      input.required_perm ?? null,
      input.due_date ?? null,
      dueOffsetDays,
      input.owner_user_id ?? null
    )
    .run();
  await logProjectActivity(env, input.project_id, "checklist_add", null, input.title, null, userId);
  return { id: r.meta.last_row_id as number };
}

const CHECKLIST_PATCH_FIELDS = [
  "title", "description", "required_perm",
  "due_date", "owner_user_id", "seq", "notes",
  "section_id",
  "role_label",
  "crew_visible",
  "pill_value",
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

  // When the user moves a task's due_date by hand, re-anchor the
  // task's offset to the project's current start_date so a future
  // project-level start_date change preserves this manual shift.
  if ("due_date" in body) {
    const row = await env.DB.prepare(
      `SELECT c.project_id, p.start_date
         FROM project_checklist c
         JOIN projects p ON p.id = c.project_id
        WHERE c.id = ?`
    )
      .bind(itemId)
      .first<{ project_id: number; start_date: string | null }>();
    let nextOffset: number | null = null;
    if (body.due_date && row?.start_date) {
      const due = new Date(String(body.due_date).slice(0, 10) + "T00:00:00Z");
      const start = new Date(String(row.start_date).slice(0, 10) + "T00:00:00Z");
      if (!isNaN(due.getTime()) && !isNaN(start.getTime())) {
        nextOffset = Math.round(
          (due.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
      }
    }
    sets.push("due_offset_days = ?");
    binds.push(nextOffset);
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
// The first eight (rental, cogs, setup, transport, commission,
// merchandise, contractor, license) are the ones surfaced as
// dedicated columns in the Finance List view + per-project breakdown
// stat strip; the rest roll up into "Others".
// 2026-05-08 — boss's Financial Snapshot model split COGS into
// product sub-categories and transport into rate-driven fee + actual
// logistics cost. Legacy `cogs` and `transport` slugs are kept so
// existing rows still display; new lines should pick from the
// sub-categories below.
export const LEDGER_COST_CATEGORIES = [
  // Rental + COGS family
  "rental",
  "cogs",                       // legacy bucket — kept for old rows
  "cogs_matt_sofa",
  "cogs_bedframe",
  "cogs_accessories",
  // Operations
  "setup",
  "transport",                  // legacy bucket — kept for old rows
  "transport_fee",              // % of sales, auto-applied by rate engine
  "transport_setup_dismantle",  // actual logistics cost
  "commission", "merchandise",
  // Misc
  "contractor", "license", "deposit", "permit",
  "accommodation", "staffing", "marketing", "misc",
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
  // Auto cost-line engine (mig 063) runs after non-auto writes only.
  // Its own writes are tagged `auto_source` and don't traverse this
  // function, so the guard is mostly for symmetry with patch/archive.
  await recomputeAutoCostLines(env, input.project_id, userId);
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
    `SELECT project_id, auto_source FROM project_finance_lines WHERE id = ?`
  )
    .bind(lineId)
    .first<{ project_id: number; auto_source: string | null }>();
  if (!line) return false;
  // Auto-generated rows are owned by the cost-rate engine — refuse
  // user edits so the next recompute doesn't silently overwrite them.
  if (line.auto_source) return false;

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
  await recomputeAutoCostLines(env, line.project_id, userId);
  await syncFinanceRollup(env, line.project_id);
  await logProjectActivity(env, line.project_id, "finance_line_edit", null, null, null, userId);
  return true;
}

export async function archiveLedgerLine(env: Env, lineId: number, userId: number) {
  const line = await env.DB.prepare(
    `SELECT project_id, auto_source FROM project_finance_lines WHERE id = ?`
  )
    .bind(lineId)
    .first<{ project_id: number; auto_source: string | null }>();
  if (!line) return false;
  // Auto rows are managed by the cost-rate engine — refuse user
  // deletes; users edit the rate card instead.
  if (line.auto_source) return false;
  await env.DB.prepare(
    `UPDATE project_finance_lines SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(lineId)
    .run();
  await recomputeAutoCostLines(env, line.project_id, userId);
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

  // Roll in sales_entries (mig 041, the rep-facing flow that replaced
  // the file-upload sales-reports section in mig 051). Drafts count too
  // — what dispatchers / Sales Director care about is "sales taken on
  // the floor", not just AutoCount-pushed ones. Voided + archived rows
  // are excluded.
  const entriesSum = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total
       FROM sales_entries
      WHERE project_id = ?
        AND archived_at IS NULL
        AND status != 'void'`
  )
    .bind(projectId)
    .first<{ total: number }>();
  const entriesTotal = entriesSum?.total ?? 0;
  // Add to whatever's already there. Reports and entries are distinct
  // record sets — a project can have both during the migration window.
  out.total_sales += entriesTotal;

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
  const transferId = r.meta.last_row_id as number;
  // Surface the transfer in the tasklist so it's visible alongside other
  // project work. Linked back via notes marker so confirm/archive can
  // toggle the matching task's status.
  await syncStockTransferTask(env, {
    transferId,
    projectId: input.project_id,
    direction: input.direction,
    transferredAt: input.transferred_at ?? null,
    confirmedAt: null,
    userId,
  });
  await logProjectActivity(
    env,
    input.project_id,
    "stock_transfer_add",
    null,
    input.direction,
    input.notes ?? null,
    userId
  );
  return { id: transferId };
}

// ── Stock transfer ↔ tasklist mirror ─────────────────────────
// Each non-archived stock transfer surfaces as one project_checklist row
// so admins can see it in the Tasklist alongside everything else. The
// link is by notes marker `auto:stock_transfer=<id>` (no schema change).
const STOCK_TRANSFER_TASK_MARKER = "auto:stock_transfer=";

function stockTransferTaskTitle(direction: string, transferredAt: string | null) {
  const verb = direction === "out" ? "Stock OUT" : "Stock RETURN";
  return transferredAt ? `${verb} — ${transferredAt}` : verb;
}

async function syncStockTransferTask(
  env: Env,
  args: {
    transferId: number;
    projectId: number;
    direction: string;
    transferredAt: string | null;
    confirmedAt: string | null;
    userId: number;
  }
) {
  const marker = `${STOCK_TRANSFER_TASK_MARKER}${args.transferId}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM project_checklist WHERE project_id = ? AND notes = ? LIMIT 1`
  )
    .bind(args.projectId, marker)
    .first<{ id: number }>();
  const status = args.confirmedAt ? "done" : "pending";
  const title = stockTransferTaskTitle(args.direction, args.transferredAt);
  if (existing) {
    await env.DB.prepare(
      `UPDATE project_checklist
          SET title = ?, due_date = ?, status = ?,
              completed_by = CASE WHEN ? = 'done' THEN ? ELSE NULL END,
              completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END,
              updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(title, args.transferredAt, status, status, args.userId || null, status, existing.id)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO project_checklist
       (project_id, seq, title, description, due_date, status,
        completed_by, completed_at, notes, created_at, updated_at)
     VALUES (?, 9000, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(
      args.projectId,
      title,
      "Auto-generated from Stock Transfers section",
      args.transferredAt,
      status,
      status === "done" ? args.userId || null : null,
      status === "done" ? new Date().toISOString() : null,
      marker
    )
    .run();
}

async function deleteStockTransferTask(env: Env, transferId: number) {
  const marker = `${STOCK_TRANSFER_TASK_MARKER}${transferId}`;
  await env.DB.prepare(
    `DELETE FROM project_checklist WHERE notes = ?`
  )
    .bind(marker)
    .run();
}

export async function confirmStockTransfer(env: Env, transferId: number, userId: number) {
  const row = await env.DB.prepare(
    `SELECT project_id, direction, transferred_at
       FROM project_stock_transfers WHERE id = ?`
  )
    .bind(transferId)
    .first<{ project_id: number; direction: string; transferred_at: string | null }>();
  if (!row) return false;
  await env.DB.prepare(
    `UPDATE project_stock_transfers
        SET confirmed_at = datetime('now'), confirmed_by = ?
      WHERE id = ?`
  )
    .bind(userId || null, transferId)
    .run();
  await syncStockTransferTask(env, {
    transferId,
    projectId: row.project_id,
    direction: row.direction,
    transferredAt: row.transferred_at,
    confirmedAt: new Date().toISOString(),
    userId,
  });
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
  const row = await env.DB.prepare(
    `SELECT project_id, direction, transferred_at
       FROM project_stock_transfers WHERE id = ?`
  )
    .bind(transferId)
    .first<{ project_id: number; direction: string; transferred_at: string | null }>();
  await env.DB.prepare(
    `UPDATE project_stock_transfers
        SET confirmed_at = NULL, confirmed_by = NULL
      WHERE id = ?`
  )
    .bind(transferId)
    .run();
  if (row) {
    await syncStockTransferTask(env, {
      transferId,
      projectId: row.project_id,
      direction: row.direction,
      transferredAt: row.transferred_at,
      confirmedAt: null,
      userId: 0,
    });
  }
}

export async function archiveStockTransfer(env: Env, transferId: number) {
  await env.DB.prepare(
    `UPDATE project_stock_transfers SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(transferId)
    .run();
  await deleteStockTransferTask(env, transferId);
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
  // Child FKs (project_checklist_attachments.item_id, project_checklist_comments.item_id)
  // were ON DELETE CASCADE but the D1->PG load dropped them to NO ACTION, so a bare
  // delete throws once a task has any attachment or comment. Clear children first.
  await env.DB.prepare(`DELETE FROM project_checklist_attachments WHERE item_id = ?`).bind(itemId).run();
  await env.DB.prepare(`DELETE FROM project_checklist_comments WHERE item_id = ?`).bind(itemId).run();
  await env.DB.prepare(`DELETE FROM project_checklist WHERE id = ?`).bind(itemId).run();
  await logProjectActivity(env, item.project_id, "checklist_remove", item.title, null, null, userId);
  return true;
}
