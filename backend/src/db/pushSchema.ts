// Drizzle definition for push_device_tokens (mig 0146).
//
// Deliberately NOT in schema.pg.ts: that file is being edited concurrently and
// this table has exactly one reader (services/apns.ts) and one writer
// (routes/push.ts). getDb(env) passes schema.pg.ts as its relational schema,
// which only powers the db.query.* API — db.select()/insert() take the table
// object directly, so a table declared here works unchanged. Fold it into
// schema.pg.ts whenever that file is quiet.
import { pgTable, bigserial, integer, text, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Same UTC text shape as schema.pg.ts's nowText. Postgres has no datetime('now').
const nowText = sql`(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`;

export const push_device_tokens = pgTable(
  "push_device_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    user_id: integer("user_id").notNull(),
    token: text("token").notNull(),
    platform: text("platform").notNull().default("ios"),
    bundle_id: text("bundle_id"),
    apns_env: text("apns_env"),
    app_version: text("app_version"),
    device_model: text("device_model"),
    created_at: text("created_at").notNull().default(nowText),
    updated_at: text("updated_at").notNull().default(nowText),
    last_seen_at: text("last_seen_at"),
    disabled_at: text("disabled_at"),
  },
  (t) => ({
    uq_token: uniqueIndex("uq_push_device_tokens_token").on(t.token),
    idx_user_live: index("idx_push_device_tokens_user_live").on(t.user_id),
  }),
);

export type PushDeviceToken = typeof push_device_tokens.$inferSelect;
