import { Hono } from "hono";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { idea_attachments } from "../db/schema";

/**
 * Polymorphic file attachments for innovations + suggestions
 * (mig 059). Mounted at `/api/idea-attachments`.
 *
 * The submitter or anyone with the wildcard `*` permission may upload
 * or remove an attachment. Listing is open to any authenticated user
 * (same gate as the parent idea endpoints, which any role can read).
 *
 * Bytes live in R2 (POD_BUCKET) under `idea-attach/{type}/{id}/{ts}-{name}`.
 */

const app = new Hono<{ Bindings: Env }>();

const ALLOWED_EXT = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "heic",
  "mp4",
  "mov",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "txt",
  "ppt",
  "pptx",
]);
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

type Target = "innovation" | "suggestion";

function isAdmin(user: any): boolean {
  return Array.isArray(user?.permissions) && user.permissions.includes("*");
}

function safeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

async function ownsParent(env: Env, target: Target, id: number, userId: number): Promise<boolean> {
  const table = target === "innovation" ? "innovations" : "suggestions";
  const row = await env.DB.prepare(`SELECT user_id FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ user_id: number }>();
  return !!row && row.user_id === userId;
}

// ── GET /api/idea-attachments?target=innovation&target_id=12 ─────
// List active (non-archived) attachments for one parent.
app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const target = c.req.query("target") as Target | undefined;
  const targetId = parseInt(c.req.query("target_id") || "", 10);
  if (target !== "innovation" && target !== "suggestion") {
    return c.json({ error: "target must be 'innovation' or 'suggestion'" }, 400);
  }
  if (!Number.isFinite(targetId)) {
    return c.json({ error: "target_id required" }, 400);
  }

  const db = getDb(c.env);
  const rows = await db
    .select({
      id: idea_attachments.id,
      file_name: idea_attachments.file_name,
      content_type: idea_attachments.content_type,
      size_bytes: idea_attachments.size_bytes,
      uploaded_by: idea_attachments.uploaded_by,
      uploaded_at: idea_attachments.uploaded_at,
      r2_key: idea_attachments.r2_key,
    })
    .from(idea_attachments)
    .where(
      and(
        eq(idea_attachments.target_type, target),
        eq(idea_attachments.target_id, targetId),
        isNull(idea_attachments.archived_at),
      ),
    )
    .orderBy(idea_attachments.id);
  return c.json({ rows });
});

// ── PUT /api/idea-attachments/:target/:id?name=…  ────────────────
// Body is the raw file bytes. Returns the inserted row.
app.put("/:target/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const target = c.req.param("target") as Target;
  const id = parseInt(c.req.param("id"), 10);
  if (target !== "innovation" && target !== "suggestion") {
    return c.json({ error: "Bad target" }, 400);
  }
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const owns = await ownsParent(c.env, target, id, user.id);
  if (!owns && !isAdmin(user)) {
    return c.json({ error: "Only the submitter or an admin can attach" }, 403);
  }

  const filenameRaw = c.req.query("name") || `attachment-${Date.now()}`;
  const filename = safeFilename(filenameRaw);
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext && !ALLOWED_EXT.has(ext)) {
    return c.json({ error: `File type .${ext} not allowed` }, 400);
  }
  const contentType = c.req.header("content-type") || "application/octet-stream";

  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > MAX_BYTES) {
    return c.json({ error: "File too large (max 25 MB)" }, 413);
  }

  const r2Key = `idea-attach/${target}/${id}/${Date.now()}-${filename}`;
  await c.env.POD_BUCKET.put(r2Key, buf, { httpMetadata: { contentType } });

  const db = getDb(c.env);
  const inserted = await db
    .insert(idea_attachments)
    .values({
      target_type: target,
      target_id: id,
      r2_key: r2Key,
      file_name: filename,
      content_type: contentType,
      size_bytes: buf.byteLength,
      uploaded_by: user.id,
    })
    .returning()
    .get();
  return c.json({ row: inserted });
});

// ── GET /api/idea-attachments/:id/blob ──────────────────────────
// Stream the bytes for one attachment.
app.get("/:id/blob", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const db = getDb(c.env);
  const row = await db
    .select({ r2_key: idea_attachments.r2_key, content_type: idea_attachments.content_type })
    .from(idea_attachments)
    .where(eq(idea_attachments.id, id))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.POD_BUCKET.get(row.r2_key);
  if (!obj) return c.json({ error: "Object missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Cache-Control": "private, max-age=300",
    },
  });
});

// ── DELETE /api/idea-attachments/:id ────────────────────────────
// Soft archive — preserves audit history. R2 bytes left in place
// (we may want them for forensics; janitor can sweep later).
app.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const db = getDb(c.env);

  const row = await db
    .select({
      target_type: idea_attachments.target_type,
      target_id: idea_attachments.target_id,
      uploaded_by: idea_attachments.uploaded_by,
    })
    .from(idea_attachments)
    .where(eq(idea_attachments.id, id))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);

  const owns =
    row.uploaded_by === user.id ||
    (await ownsParent(c.env, row.target_type as Target, row.target_id, user.id));
  if (!owns && !isAdmin(user)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db
    .update(idea_attachments)
    .set({ archived_at: sql`datetime('now')` })
    .where(eq(idea_attachments.id, id));
  return c.json({ ok: true });
});

export default app;
