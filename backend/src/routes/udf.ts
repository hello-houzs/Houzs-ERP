import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

// Allowed table identifiers — keeps the namespace bounded so a typo in the
// frontend can't create orphan UDF rows in random table buckets.
const ALLOWED_TABLES = new Set([
  "sales_orders",
  "delivery_orders",
  "purchase_orders",
  "assr",
  "balance",
  "overdue",
  "logs",
  // Rep-entered sales transactions. row_key = sales_entries.id (as string).
  "sales_entries",
]);

const ALLOWED_TYPES = new Set(["text", "number", "date", "select", "checkbox"]);

function validateTable(table: string): boolean {
  return ALLOWED_TABLES.has(table);
}

// snake_case validator — letters, digits, underscores; must start with a letter
function validateKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,39}$/.test(key);
}

/**
 * GET /api/udf/:table → list all UDF fields + their values for that table.
 * Returns:
 *   {
 *     fields: [{ id, key, label, type, options }, ...],
 *     values: { [row_key]: { [field_key]: value } }
 *   }
 *
 * The values map covers every UDF row in this table — for tables in the
 * thousands of rows this is still small (UDF columns count is bounded by
 * what users actually create). If it ever gets large we can switch to
 * batched ?keys=... queries.
 */
app.get("/:table", async (c) => {
  const table = c.req.param("table");
  if (!validateTable(table)) return c.json({ error: "Invalid table" }, 400);

  const fieldsRes = await c.env.DB.prepare(
    `SELECT id, field_key as key, label, field_type as type, options, position
     FROM udf_fields WHERE table_name = ?
     ORDER BY position ASC, id ASC`
  )
    .bind(table)
    .all();

  const fields = (fieldsRes.results || []).map((r: any) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type,
    options: r.options ? JSON.parse(r.options) : null,
    position: r.position ?? 0,
  }));

  const valuesRes = await c.env.DB.prepare(
    `SELECT row_key, field_key, value FROM udf_values WHERE table_name = ?`
  )
    .bind(table)
    .all<{ row_key: string; field_key: string; value: string | null }>();

  const values: Record<string, Record<string, string | null>> = {};
  for (const row of valuesRes.results || []) {
    if (!values[row.row_key]) values[row.row_key] = {};
    values[row.row_key][row.field_key] = row.value;
  }

  return c.json({ fields, values });
});

/**
 * POST /api/udf/:table — create a new UDF field.
 * Body: { key, label, type, options? }
 */
app.post("/:table", requirePermission("udf.manage"), async (c) => {
  const table = c.req.param("table");
  if (!validateTable(table)) return c.json({ error: "Invalid table" }, 400);

  const body = await c.req.json<{
    key: string;
    label: string;
    type?: string;
    options?: string[];
  }>();

  if (!body.key || !body.label) {
    return c.json({ error: "key and label are required" }, 400);
  }
  if (!validateKey(body.key)) {
    return c.json(
      { error: "key must be snake_case (a-z, 0-9, _) and start with a letter" },
      400
    );
  }
  const type = body.type || "text";
  if (!ALLOWED_TYPES.has(type)) {
    return c.json({ error: `type must be one of ${[...ALLOWED_TYPES].join(", ")}` }, 400);
  }
  if (type === "select" && (!body.options || !body.options.length)) {
    return c.json({ error: "select fields require options" }, 400);
  }

  const exists = await c.env.DB.prepare(
    `SELECT id FROM udf_fields WHERE table_name = ? AND field_key = ?`
  )
    .bind(table, body.key)
    .first();
  if (exists) return c.json({ error: "A field with that key already exists" }, 409);

  // Position: append at the end
  const maxPos = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 as next FROM udf_fields WHERE table_name = ?`
  )
    .bind(table)
    .first<{ next: number }>();

  const result = await c.env.DB.prepare(
    `INSERT INTO udf_fields (table_name, field_key, label, field_type, options, position)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      table,
      body.key,
      body.label,
      type,
      body.options ? JSON.stringify(body.options) : null,
      maxPos?.next ?? 0
    )
    .run();

  return c.json({
    id: result.meta.last_row_id,
    key: body.key,
    label: body.label,
    type,
    options: body.options ?? null,
    position: maxPos?.next ?? 0,
  });
});

/**
 * DELETE /api/udf/:table/:key — remove a field and all its values.
 */
app.delete("/:table/:key", requirePermission("udf.manage"), async (c) => {
  const table = c.req.param("table");
  const key = c.req.param("key");
  if (!validateTable(table)) return c.json({ error: "Invalid table" }, 400);

  await c.env.DB.prepare(
    `DELETE FROM udf_values WHERE table_name = ? AND field_key = ?`
  )
    .bind(table, key)
    .run();

  const res = await c.env.DB.prepare(
    `DELETE FROM udf_fields WHERE table_name = ? AND field_key = ?`
  )
    .bind(table, key)
    .run();

  if (!res.meta.changes) return c.json({ error: "Field not found" }, 404);
  return c.json({ ok: true });
});

/**
 * PUT /api/udf/:table/values/:rowKey — upsert one or more values for a row.
 * Body: { [field_key]: value | null }
 * Setting a value to null deletes the row's value for that field (so empty
 * cells don't accumulate dead rows).
 */
app.put("/:table/values/:rowKey", requirePermission("udf.manage"), async (c) => {
  const table = c.req.param("table");
  const rowKey = c.req.param("rowKey");
  if (!validateTable(table)) return c.json({ error: "Invalid table" }, 400);

  const body = await c.req.json<Record<string, string | null>>();
  if (!body || typeof body !== "object") {
    return c.json({ error: "Body must be an object of field_key → value" }, 400);
  }

  // Validate all keys against the table's known fields
  const fieldsRes = await c.env.DB.prepare(
    `SELECT field_key FROM udf_fields WHERE table_name = ?`
  )
    .bind(table)
    .all<{ field_key: string }>();
  const known = new Set((fieldsRes.results || []).map((r) => r.field_key));

  for (const k of Object.keys(body)) {
    if (!known.has(k)) {
      return c.json({ error: `Unknown field: ${k}` }, 400);
    }
  }

  for (const [fieldKey, value] of Object.entries(body)) {
    if (value == null || value === "") {
      await c.env.DB.prepare(
        `DELETE FROM udf_values WHERE table_name = ? AND row_key = ? AND field_key = ?`
      )
        .bind(table, rowKey, fieldKey)
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO udf_values (table_name, row_key, field_key, value, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(table_name, row_key, field_key)
         DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
        .bind(table, rowKey, fieldKey, String(value))
        .run();
    }
  }

  return c.json({ ok: true });
});

export default app;
