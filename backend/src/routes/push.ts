// /api/push — APNs device-token registration for the iOS shell.
//
// ACCESS: any authenticated user, matching /api/notifications. A device token
// is personal plumbing for the caller's own notifications, so this must never
// 403 on a matrix permission — a Sales user who lacks projects.read still has a
// bell, and still has a phone. The routes only ever touch the caller's own
// rows; there is no path here that reads or writes another user's device.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { push_device_tokens } from "../db/pushSchema";
import { and, eq } from "drizzle-orm";
import { requirePermission } from "../middleware/auth";
import { isApnsConfigured, sendPushToUser } from "../services/apns";

const app = new Hono<{ Bindings: Env }>();

// Same UTC text shape the public schema stores everywhere (mig 0008).
function nowText(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

const registerSchema = z.object({
  // Hex only, and bounded: this value is interpolated into the APNs request
  // path, so anything else is refused at the door rather than sanitised later.
  token: z.string().regex(/^[0-9a-fA-F]{32,200}$/),
  platform: z.enum(["ios", "android"]).default("ios"),
  bundle_id: z.string().max(200).optional(),
  apns_env: z.enum(["production", "sandbox"]).optional(),
  app_version: z.string().max(50).optional(),
  device_model: z.string().max(100).optional(),
});

/**
 * POST /api/push/devices — register or refresh this device.
 *
 * Idempotent by construction: the unique index is on token alone (mig 0146), so
 * a re-registration UPDATEs in place, and a token whose handset is now signed
 * in as somebody else is REASSIGNED to that user. Re-registering also clears
 * disabled_at — a reinstall on a token we had retired is a live device again.
 */
app.post("/devices", async (c) => {
  const me = c.get("user");
  if (!me || me.id === 0) return c.json({ error: "Unauthorized" }, 401);

  const parsed = registerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid device registration" }, 400);
  }
  const d = parsed.data;
  const stamp = nowText();
  const token = d.token.toLowerCase();

  const db = getDb(c.env);
  await db
    .insert(push_device_tokens)
    .values({
      user_id: me.id,
      token,
      platform: d.platform,
      bundle_id: d.bundle_id ?? null,
      apns_env: d.apns_env ?? null,
      app_version: d.app_version ?? null,
      device_model: d.device_model ?? null,
      created_at: stamp,
      updated_at: stamp,
      last_seen_at: stamp,
      disabled_at: null,
    })
    .onConflictDoUpdate({
      target: push_device_tokens.token,
      set: {
        user_id: me.id,
        platform: d.platform,
        bundle_id: d.bundle_id ?? null,
        apns_env: d.apns_env ?? null,
        app_version: d.app_version ?? null,
        device_model: d.device_model ?? null,
        updated_at: stamp,
        last_seen_at: stamp,
        disabled_at: null,
      },
    });

  return c.json({ ok: true, configured: isApnsConfigured(c.env) });
});

/**
 * POST /api/push/devices/unregister — stop pushing to this device.
 *
 * A hard DELETE, not a disabled_at stamp. This is the sign-out path on a shared
 * handset, and a soft-deleted row still carries the association between a token
 * and the person who just handed the device over.
 *
 * Scoped to the caller's own rows: a token that has already been reassigned to
 * the next user must NOT be deletable by the previous one, or signing out on
 * one phone would silently mute somebody else's.
 */
app.post("/devices/unregister", async (c) => {
  const me = c.get("user");
  if (!me || me.id === 0) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const token = String((body as { token?: unknown }).token ?? "").toLowerCase();
  if (!/^[0-9a-f]{32,200}$/.test(token)) {
    return c.json({ error: "Invalid token" }, 400);
  }

  const db = getDb(c.env);
  await db
    .delete(push_device_tokens)
    .where(
      and(eq(push_device_tokens.token, token), eq(push_device_tokens.user_id, me.id)),
    );

  return c.json({ ok: true });
});

/**
 * POST /api/push/test — send a push to the caller's own devices.
 *
 * Owner-gated. This exists because the APNs path cannot be exercised from
 * `wrangler dev` (workerd's outbound fetch is HTTP/1.1; APNs is HTTP/2 only),
 * so the ONLY way to prove credentials and topic are right is to fire one from
 * a deployed Worker. The response carries the per-device outcome rather than a
 * bare ok, because "0 sent, 1 failed" and "no devices registered" are different
 * problems and a boolean cannot tell them apart.
 */
app.post("/test", requirePermission("*"), async (c) => {
  const me = c.get("user");
  if (!me || me.id === 0) return c.json({ error: "Unauthorized" }, 401);
  if (!isApnsConfigured(c.env)) {
    return c.json({ ok: false, error: "apns_not_configured" }, 503);
  }
  const result = await sendPushToUser(c.env, me.id, {
    title: "Houzs ERP",
    body: "Push notifications are working.",
    data: { kind: "test", id: "0" },
  });
  return c.json({ ok: result.sent > 0, ...result });
});

export default app;
