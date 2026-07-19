// ─────────────────────────────────────────────────────────────────────────
// personalNotice.ts — the ONE insert path for SYSTEM-generated per-user
// notices delivered through the announcements machinery.
//
// Owner 2026-07-04: "就用 announcement 的功能,只有自己看到,像 notification 那样."
// A system notice is a PRIVATE announcement (target_type USER_IDS) so it rides
// the unread dot + /banner + Announcements screen users already have — no new
// notification table, no web-push infra. A `source` tag (e.g. 'scan',
// 'service_case') keeps these out of the office composer list (GET
// /api/announcements filters non-null sources out; /banner still surfaces them).
//
// Both the background slip-scan flow (scan-so.ts) and the service-case notify
// (assrNotify.ts) go through here so there is a SINGLE announcements-insert
// path, not a hand-rolled copy per caller. Fail-soft is the caller's job to
// decide, but this helper never throws: a notice insert must never fail the
// business operation that triggered it.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { bustBannerForUser } from "./configCache";

// The announcements category CHECK constraint (mig 0058) allows only these.
export type PersonalNoticeCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

/**
 * Insert ONE private per-user announcement targeting `userIds`.
 *
 * De-dupes the id list, skips silently when it is empty (a private notice needs
 * a target), and NEVER throws — any failure is logged and swallowed so the
 * triggering operation is unaffected. Mirrors the exact column set the scan
 * notice has used since mig 0071 (no company columns — a null-company notice is
 * visible to its targeted users regardless of the caller's company context).
 */
export async function postPersonalNotice(
  env: Env,
  opts: {
    userIds: Array<number | null | undefined>;
    category: PersonalNoticeCategory;
    title: string;
    body: string;
    source: string;
    /** Banner self-clears after this many days. Defaults to 14. */
    expiresDays?: number;
  },
): Promise<void> {
  try {
    const ids = Array.from(
      new Set(
        (opts.userIds ?? [])
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
    if (ids.length === 0) return; // no target → nothing to deliver

    const id = `ann-${crypto.randomUUID().slice(0, 12).replace(/-/g, "")}`;
    const nowIso = new Date().toISOString();
    const days = opts.expiresDays && opts.expiresDays > 0 ? opts.expiresDays : 14;
    const expiresIso = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(
      `INSERT INTO announcements
         (id, title, body, is_active, expires_at, created_by, created_at,
          translations, attachments, target_type,
          target_dept_ids, target_position_ids, target_user_ids, category, source)
       VALUES (?, ?, ?, 1, ?, NULL, ?, NULL, NULL, 'USER_IDS', NULL, NULL, ?, ?, ?)`,
    )
      .bind(
        id,
        opts.title,
        opts.body,
        expiresIso,
        nowIso,
        JSON.stringify(ids),
        opts.category,
        opts.source,
      )
      .run();
    // A private notice only changes its TARGETED users' banners — bust just
    // those snapshots (usually one), not the whole family version.
    for (const uid of ids) {
      await bustBannerForUser(env, uid);
    }
  } catch (e) {
    console.error(
      `[personal-notice] insert failed (source=${opts.source}):`,
      (e as Error).message,
    );
  }
}
