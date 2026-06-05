import { Hono } from "hono";
import type { Env } from "../types";
import { getUserPhasesOnProject } from "../services/projects";

/**
 * Driver-App-facing project surface.
 *
 * Drivers / helpers see only the projects they are crewed on (per mig 083
 * setup_/dismantle_ columns) and only the slice of project data they need
 * to do the job on the day — no finance, sales, chat, or full team.
 *
 * Authorisation is row-scoped via crew membership. No new permission keys.
 */
const app = new Hono<{ Bindings: Env }>();

const CREW_PREDICATE = `(
       p.setup_driver_user_id   = ? OR
       p.setup_helper_1_id      = ? OR
       p.setup_helper_2_id      = ? OR
       p.dismantle_driver_user_id = ? OR
       p.dismantle_helper_1_id    = ? OR
       p.dismantle_helper_2_id    = ?
     )`;

function crewBinds(userId: number) {
  return [userId, userId, userId, userId, userId, userId];
}

// ── List projects I'm crewed on ───────────────────────────────
app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const userId = user.id;

  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.venue, p.venue_address,
            p.state, p.start_date, p.end_date,
            p.setup_start_at, p.setup_end_at,
            p.dismantle_start_at, p.dismantle_end_at,
            p.setup_driver_user_id, p.setup_helper_1_id, p.setup_helper_2_id,
            p.dismantle_driver_user_id, p.dismantle_helper_1_id, p.dismantle_helper_2_id
       FROM projects p
      WHERE ${CREW_PREDICATE}
        AND p.archived_at IS NULL
      ORDER BY COALESCE(p.start_date, p.created_at) DESC`
  )
    .bind(...crewBinds(userId))
    .all<any>();

  const data = (rows.results ?? []).map((r) => {
    const my_phases: string[] = [];
    if (
      r.setup_driver_user_id === userId ||
      r.setup_helper_1_id === userId ||
      r.setup_helper_2_id === userId
    ) {
      my_phases.push("setup");
    }
    if (
      r.dismantle_driver_user_id === userId ||
      r.dismantle_helper_1_id === userId ||
      r.dismantle_helper_2_id === userId
    ) {
      my_phases.push("dismantle");
    }
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      brand: r.brand,
      venue: r.venue,
      venue_address: r.venue_address,
      state: r.state,
      start_date: r.start_date,
      end_date: r.end_date,
      setup_start_at: r.setup_start_at,
      setup_end_at: r.setup_end_at,
      dismantle_start_at: r.dismantle_start_at,
      dismantle_end_at: r.dismantle_end_at,
      my_phases,
    };
  });

  return c.json({ data });
});

// ── Project brief (driver-app slice) ──────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const phases = await getUserPhasesOnProject(c.env, id, user.id);
  if (!phases.length) return c.json({ error: "Forbidden" }, 403);

  const project = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.venue, p.venue_address,
            p.state, p.start_date, p.end_date,
            p.setup_start_at, p.setup_end_at,
            p.dismantle_start_at, p.dismantle_end_at,
            p.setup_helper_outsourced, p.dismantle_helper_outsourced,
            p.setup_driver_user_id, p.setup_helper_1_id, p.setup_helper_2_id,
            p.dismantle_driver_user_id, p.dismantle_helper_1_id, p.dismantle_helper_2_id,
            p.setup_lorry_id, p.dismantle_lorry_id,
            p.pic_id,
            pic.name as pic_name, pic.phone as pic_phone,
            ud1.name  as setup_driver_name,
            uh11.name as setup_helper_1_name,
            uh12.name as setup_helper_2_name,
            ud2.name  as dismantle_driver_name,
            uh21.name as dismantle_helper_1_name,
            uh22.name as dismantle_helper_2_name,
            ud1.phone  as setup_driver_phone,
            uh11.phone as setup_helper_1_phone,
            uh12.phone as setup_helper_2_phone,
            ud2.phone  as dismantle_driver_phone,
            uh21.phone as dismantle_helper_1_phone,
            uh22.phone as dismantle_helper_2_phone,
            l1.plate as setup_lorry_plate,
            l2.plate as dismantle_lorry_plate
       FROM projects p
       LEFT JOIN users pic  ON pic.id = p.pic_id
       LEFT JOIN users ud1  ON ud1.id = p.setup_driver_user_id
       LEFT JOIN users uh11 ON uh11.id = p.setup_helper_1_id
       LEFT JOIN users uh12 ON uh12.id = p.setup_helper_2_id
       LEFT JOIN users ud2  ON ud2.id = p.dismantle_driver_user_id
       LEFT JOIN users uh21 ON uh21.id = p.dismantle_helper_1_id
       LEFT JOIN users uh22 ON uh22.id = p.dismantle_helper_2_id
       LEFT JOIN lorries l1 ON l1.id = p.setup_lorry_id
       LEFT JOIN lorries l2 ON l2.id = p.dismantle_lorry_id
      WHERE p.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!project) return c.json({ error: "Not found" }, 404);

  // Photos for the phases I am crewed on.
  const placeholders = phases.map(() => "?").join(",");
  const photos = await c.env.DB.prepare(
    `SELECT pp.id, pp.phase, pp.r2_key, pp.content_type, pp.caption,
            pp.uploaded_by, u.name as uploaded_by_name, pp.uploaded_at
       FROM project_phase_photos pp
       LEFT JOIN users u ON u.id = pp.uploaded_by
      WHERE pp.project_id = ?
        AND pp.phase IN (${placeholders})
      ORDER BY pp.uploaded_at DESC, pp.id DESC`
  )
    .bind(id, ...phases)
    .all<any>();

  // Crew-visible tasklist items (mig 086). Read-only window into the
  // project's documents — booth layout, work permit, floorplan, etc.
  // — for the driver to pull up on site. Attachments stitched in via a
  // second query keyed on the visible item ids.
  const docItems = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.description, c.role_label, c.status,
            c.section_id, c.seq, s.name as section_name, s.sort_order as section_sort
       FROM project_checklist c
       LEFT JOIN project_checklist_sections s ON s.id = c.section_id
      WHERE c.project_id = ?
        AND c.crew_visible = 1
      ORDER BY COALESCE(s.sort_order, 9999), c.seq, c.id`
  )
    .bind(id)
    .all<{
      id: number;
      title: string;
      description: string | null;
      role_label: string | null;
      status: string;
      section_id: number | null;
      seq: number;
      section_name: string | null;
      section_sort: number | null;
    }>();
  const docItemRows = docItems.results ?? [];

  let docAttachments: any[] = [];
  if (docItemRows.length) {
    const itemPlaceholders = docItemRows.map(() => "?").join(",");
    const att = await c.env.DB.prepare(
      `SELECT att.id, att.item_id, att.r2_key, att.file_name,
              att.content_type, att.size_bytes, att.uploaded_at,
              u.name as uploaded_by_name
         FROM project_checklist_attachments att
         LEFT JOIN users u ON u.id = att.uploaded_by
        WHERE att.archived_at IS NULL
          AND att.item_id IN (${itemPlaceholders})
        ORDER BY att.uploaded_at DESC, att.id DESC`
    )
      .bind(...docItemRows.map((r) => r.id))
      .all<any>();
    docAttachments = att.results ?? [];
  }
  const attsByItem = new Map<number, any[]>();
  for (const a of docAttachments) {
    const arr = attsByItem.get(a.item_id) ?? [];
    arr.push(a);
    attsByItem.set(a.item_id, arr);
  }
  const documents = docItemRows.map((it) => ({
    id: it.id,
    title: it.title,
    description: it.description,
    role_label: it.role_label,
    status: it.status,
    section_name: it.section_name,
    attachments: attsByItem.get(it.id) ?? [],
  }));

  // Resolve "my role" tags per phase ("Setup Driver", "Setup Helper 1", ...).
  const my_roles: Record<string, string> = {};
  if (project.setup_driver_user_id === user.id) my_roles.setup = "Setup Driver";
  else if (project.setup_helper_1_id === user.id) my_roles.setup = "Setup Helper 1";
  else if (project.setup_helper_2_id === user.id) my_roles.setup = "Setup Helper 2";
  if (project.dismantle_driver_user_id === user.id) my_roles.dismantle = "Dismantle Driver";
  else if (project.dismantle_helper_1_id === user.id) my_roles.dismantle = "Dismantle Helper 1";
  else if (project.dismantle_helper_2_id === user.id) my_roles.dismantle = "Dismantle Helper 2";

  return c.json({
    project,
    my_phases: phases,
    my_roles,
    documents,
    photos: photos.results ?? [],
  });
});

// ── Phase photo upload (two-step like office side) ────────────
app.put("/:id/photos/upload", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const phase = (c.req.query("phase") || "").toLowerCase();
  if (phase !== "setup" && phase !== "dismantle") {
    return c.json({ error: "phase must be setup or dismantle" }, 400);
  }
  const phases = await getUserPhasesOnProject(c.env, id, user.id);
  if (!phases.includes(phase as "setup" | "dismantle")) {
    return c.json({ error: "Not crewed on this phase" }, 403);
  }

  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  // Images render inline, documents download. Videos play inline via
  // MediaLightbox. 50MB cap so a typical phone clip uploads cleanly.
  const MIME_BY_EXT: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    m4v: "video/x-m4v",
  };
  const mime = MIME_BY_EXT[ext];
  if (!mime) return c.json({ error: "unsupported type" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 50 * 1024 * 1024) return c.json({ error: "Max 50MB" }, 400);
  const key = `project-phase-photos/${id}/${phase}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ key, mime_type: mime });
});

app.post("/:id/photos", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    phase?: "setup" | "dismantle";
    r2_key?: string;
    content_type?: string;
    caption?: string | null;
  }>();
  const phase = body.phase;
  if (phase !== "setup" && phase !== "dismantle") {
    return c.json({ error: "phase required" }, 400);
  }
  if (!body.r2_key) return c.json({ error: "r2_key required" }, 400);

  const phases = await getUserPhasesOnProject(c.env, id, user.id);
  if (!phases.includes(phase)) {
    return c.json({ error: "Not crewed on this phase" }, 403);
  }

  const r = await c.env.DB.prepare(
    `INSERT INTO project_phase_photos
       (project_id, phase, r2_key, content_type, caption, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, phase, body.r2_key, body.content_type ?? null, body.caption ?? null, user.id)
    .run();
  return c.json({ id: r.meta.last_row_id });
});

export default app;
