// /api/announcements/banner?includeSystem=false — the mobile persistent list.
//
// Pins the owner 2026-07-20 parity fix: the mobile Announcements LIST asks for
// human-authored posts only (source IS NULL), matching the desktop page, while
// the default /banner (desktop top-banner popup + every existing caller) still
// surfaces the system scan / service-case notices. The human-only variant also
// bypasses the KV snapshot (its result set differs and the cache key is not
// keyed on the param).
//
// Harness mirrors configCache.test.ts's banner section: a bare Hono app that
// stands in the user, the real announcements router, and a minimal D1 mirror of
// the pg-only tables.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import announcementRoutes from "../src/routes/announcements";

const state = { user: undefined as unknown };
const app = new Hono();
app.use("*", async (c: never, next: never) => {
  (c as { set: (k: string, v: unknown) => void }).set("user", state.user);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/announcements", announcementRoutes);

const USER = { id: 505, department_id: null, position_id: null, permissions: [] as string[], permissions_set: new Set<string>() };

async function getBanner(includeSystem: boolean) {
  state.user = USER;
  const path = includeSystem
    ? "/api/announcements/banner"
    : "/api/announcements/banner?includeSystem=false";
  const res = await app.request(path, {}, env as never);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data?: Array<{ id: string; source?: string | null }> };
  return {
    cache: res.headers.get("x-config-cache"),
    ids: (body.data ?? []).map((a) => a.id),
    sources: (body.data ?? []).map((a) => a.source ?? null),
  };
}

describe("/api/announcements/banner — includeSystem filter", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcements (
         id TEXT PRIMARY KEY, title TEXT, body TEXT, is_active INTEGER,
         expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
         updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
         target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
         target_user_ids TEXT, target_company_ids TEXT, category TEXT,
         source TEXT, company_id INTEGER)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_acks (
         announcement_id TEXT, user_id INTEGER, acked_at TEXT, company_id INTEGER,
         PRIMARY KEY (announcement_id, user_id))`,
    ).run();
  });

  test("default feed includes the system notice; includeSystem=false excludes it and bypasses cache", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    // A human post (source NULL) and a system scan notice, both targeting USER.
    await env.DB.prepare(
      `INSERT INTO announcements (id, title, body, is_active, expires_at, created_at, target_type, target_user_ids, category, source)
       VALUES ('ann-human', 'Office memo', 'b', 1, ?, ?, 'USER_IDS', '[505]', 'GENERAL', NULL)`,
    ).bind(future, new Date().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO announcements (id, title, body, is_active, expires_at, created_at, target_type, target_user_ids, category, source)
       VALUES ('ann-scan', 'Sales order saved', 'b', 1, ?, ?, 'USER_IDS', '[505]', 'GENERAL', 'scan')`,
    ).bind(future, new Date().toISOString()).run();

    const full = await getBanner(true);
    expect(full.ids.sort()).toEqual(["ann-human", "ann-scan"]);

    const humanOnly = await getBanner(false);
    expect(humanOnly.ids).toEqual(["ann-human"]);
    expect(humanOnly.sources).toEqual([null]);
    // The human-only variant is never served from (or written to) the snapshot.
    expect(humanOnly.cache).toBe("bypass");
  });
});
