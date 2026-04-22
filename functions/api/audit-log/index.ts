// GET /api/audit-log — admin-only listing with filters
//   ?user=<id>   filter by user_id
//   ?action=<a>  filter by action
//   ?entity=<t>  filter by entity_type
//   ?from=<ISO>  filter by timestamp >=
//   ?to=<ISO>    filter by timestamp <=
//   ?limit=200   default 200, max 1000

import { Env, json } from "../../_shared";
import { requireAuth, requireRole } from "../../_auth";

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const roleErr = requireRole(user, "Sales Director");
  if (roleErr) return roleErr;

  const url = new URL(request.url);
  const clauses: string[] = [];
  const vals: unknown[] = [];
  const userId = url.searchParams.get("user");
  if (userId) { clauses.push("user_id = ?"); vals.push(userId); }
  const action = url.searchParams.get("action");
  if (action) { clauses.push("action = ?"); vals.push(action); }
  const entity = url.searchParams.get("entity");
  if (entity) { clauses.push("entity_type = ?"); vals.push(entity); }
  const from = url.searchParams.get("from");
  if (from) { clauses.push("timestamp >= ?"); vals.push(from); }
  const to = url.searchParams.get("to");
  if (to) { clauses.push("timestamp <= ?"); vals.push(to); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));

  const { results } = await env.DB.prepare(
    `SELECT id, user_id, user_name, user_position, action, entity_type, entity_id,
            field, old_value, new_value, changes_json, ip_address, user_agent, timestamp
       FROM audit_log ${where}
      ORDER BY timestamp DESC, id DESC
      LIMIT ${limit}`
  ).bind(...vals).all<Record<string, unknown>>();

  return json(results.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userPosition: r.user_position,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    field: r.field,
    oldValue: r.old_value,
    newValue: r.new_value,
    changes: r.changes_json ? JSON.parse(r.changes_json as string) : null,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    timestamp: r.timestamp,
  })));
};
