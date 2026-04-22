// GET  /api/permissions  — list all role_permissions rows (HQ/Super Admin only)
// PUT  /api/permissions  — bulk-upsert role_permissions rows (HQ/Super Admin only)
//
// Shape on the wire is camelCase, snake_case in SQL. Returns/accepts a flat
// array of { department, position, moduleKey, level } — all 208 rows
// (13 roles x 16 modules). The PUT does INSERT OR REPLACE via env.DB.batch()
// so the whole matrix is rewritten atomically in one round-trip.

import { Env, json, error } from "../../_shared";
import { requireAuth, logAudit } from "../../_auth";

type AccessLevel = "NONE" | "VIEW" | "EDIT" | "FULL";
const VALID_LEVELS: AccessLevel[] = ["NONE", "VIEW", "EDIT", "FULL"];
const VALID_DEPARTMENTS = new Set(["SALES", "OPERATION", "HQ"]);

interface PermissionRow {
  department: "SALES" | "OPERATION" | "HQ";
  position: string;
  moduleKey: string;
  level: AccessLevel;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  if (user.position !== "Super Admin") return error("Requires role: Super Admin", 403);

  const { results } = await env.DB.prepare(
    `SELECT department, position, module_key, level
       FROM role_permissions
       ORDER BY department, position, module_key`
  ).all<{ department: string; position: string; module_key: string; level: string }>();

  return json(results.map((r) => ({
    department: r.department,
    position: r.position,
    moduleKey: r.module_key,
    level: r.level as AccessLevel,
  })));
};

export const onRequestPut: PagesFunction<Env> = async ({ env, request }) => {
  const admin = await requireAuth(request, env);
  if (admin instanceof Response) return admin;
  if (admin.position !== "Super Admin") return error("Requires role: Super Admin", 403);

  const body = await request.json<PermissionRow[]>().catch(() => null);
  if (!Array.isArray(body)) return error("Expected an array of permission rows");

  // Validate every row upfront — reject the whole batch if any are malformed.
  const stmts = [];
  for (let i = 0; i < body.length; i++) {
    const row = body[i];
    if (!row || typeof row !== "object") return error(`Row ${i}: invalid shape`);
    const { department, position, moduleKey, level } = row;
    if (!VALID_DEPARTMENTS.has(department)) return error(`Row ${i}: invalid department "${department}"`);
    if (!position || typeof position !== "string") return error(`Row ${i}: invalid position`);
    if (!moduleKey || typeof moduleKey !== "string") return error(`Row ${i}: invalid moduleKey`);
    if (!VALID_LEVELS.includes(level)) return error(`Row ${i}: invalid level "${level}"`);
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO role_permissions (department, position, module_key, level, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).bind(department, position, moduleKey, level),
    );
  }

  if (stmts.length > 0) await env.DB.batch(stmts);

  await logAudit(env, request, admin, {
    action: "update",
    entityType: "role_permissions",
    changes: { rowCount: stmts.length },
  });

  return json({ ok: true, rowCount: stmts.length });
};
