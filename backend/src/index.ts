import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { auth, requirePermission, requireAnyPermission, requireScmAccess } from "./middleware/auth";
import { TRANSIENT_CONN_RE } from "./db/d1-compat";
// Ported 2990's SCM modules (furniture supply chain). Talk to the `scm` Postgres
// schema via supabase-js; namespaced under /api/scm/*, owner-only during the port.
import scmApp from "./scm";
import { idempotency } from "./middleware/idempotency";
import { requestLog } from "./middleware/requestLog";
import assr from "./routes/assr";
import logs from "./routes/logs";
import auditRoutes from "./routes/audit";
import systemHealthRoutes from "./routes/systemHealth";
import udf from "./routes/udf";
import authRoutes from "./routes/auth";
import totpRoutes from "./routes/totp";
import users from "./routes/users";
import roles from "./routes/roles";
import positions from "./routes/positions";
import departments from "./routes/departments";
import companies from "./routes/companies";
import notifications from "./routes/notifications";
import presence from "./routes/presence";
import events from "./routes/events";
import projects from "./routes/projects";
// Sales entries (/api/sales) is retained as a DEPENDENCY of Projects — the
// Projects page embeds the sales-entry EntryPanel + submit/void/delete flow.
// It has no standalone nav/route after the cutover.
import sales from "./routes/sales";
// Endpoints retained ONLY because the kept Service/Projects pages still call
// them (no standalone nav/route): finance.ts backs the Finances P&L tab on both
// Service and Projects (PnlCalendar); stockItems backs the ASSR By-Creditor
// "Refresh from AutoCount" button; fleet/lorries back the Projects Setup /
// Dismantle / Logistics crew + lorry pickers.
import finance from "./routes/finance";
import stockItems from "./routes/stockItems";
import fleet from "./routes/fleet";
// `routes/lorries.ts` removed 2026-06-28 — old Houzs Fleet lorries CRUD retired
// in favour of scm.lorries (mounted at /api/scm/lorries). public.lorries data
// was migrated by mig 0055 then the dead table dropped. /api/fleet/staff stays
// — it reads public.users by role for the project Setup/Dismantle crew picker
// (distinct from the new SCM TMS crew records).
import settings from "./routes/settings";
import branding from "./routes/branding";
import inbox, { bustInboxForUser } from "./routes/inbox";
import projectsPrint from "./routes/projects_print";
import search from "./routes/search";
import assrPrint from "./routes/assr_print";
import assrPortal from "./routes/assrPortal";
import assrFormIntake from "./routes/assrFormIntake";
import survey from "./routes/survey";
import track from "./routes/track";
import portal from "./routes/portal";
import supplierPortal from "./routes/supplierPortal";
// Mail Center — in-ERP shared inbox. `mailInbound` is the PRE-AUTH ingest
// (secret-guarded, mounted before the auth gate); `mailCenter` is the authed
// read/reply/compose/label/address/access/scope router.
import mailCenter from "./routes/mail-center";
import mailInbound from "./routes/mail-inbound";
// 2990 → Houzs LIVE SO mirror receiver. PRE-AUTH (secret-guarded, called by the
// 2990 DB via pg_net, no user JWT) — mounted at the top level, outside /api/scm.
import { soMirror } from "./scm/routes/so-mirror";
// POS auth (Phase 1 of the 2990-backend replacement): PIN/session login for the
// 2990 POS. Mounted PRE-AUTH; its two write endpoints re-apply `auth` per-route.
import pos from "./routes/pos";
// Announcements — office posts every logged-in user sees as a top banner with
// a "Got it" ack. Ported from Hookka (single-tenant + office-only here).
import announcements from "./routes/announcements";
// Agent Console — owner-only fleet console for the HOOKKA-ported agents
// (Delivery/Document/CS). Skeleton: controls + runs + config proposals +
// feedback; the engines register themselves in services/agent-scheduler.ts.
import agentConsole from "./routes/agent-console";
import { caseTrack } from "./middleware/caseTrack";
import { supplierTrack } from "./middleware/supplierTrack";
import { dbInject, withPgDb } from "./middleware/db";
import { companyContext } from "./middleware/companyContext";
import { drainEmailOutbox } from "./services/email";
import { runSlaEscalation } from "./services/assrEscalation";
import { runAssrAlerts, runAssrDailyDigest } from "./services/assrAlerts";
import { runScheduledLeadTimeActivations } from "./services/assrLeadTime";
import { runProjectDueReminders } from "./services/projectReminders";
// Weekly OCR rule-distill (scan-so self-evolution). Run via the daily 02:00
// slot gated to Sundays — no new cron trigger. getSupabaseService is the same
// service client scan-so.ts uses internally (serviceClient(env)).
import { distillAllSalespersonRules, warmCatalogCacheForCron, processScanQueueMessage } from "./scm/routes/scan-so";
import { runAgentHeartbeat } from "./services/agent-scheduler";
import { getSupabaseService } from "./db/supabase";
import { getBranding } from "./services/branding";

const app = new Hono<{ Bindings: Env }>();

// After a successful ASSR/Projects write, bust the acting user's inbox snapshot
// so their own inbox self-heals on the next load (see routes/inbox.ts). Runs the
// handler first, then busts on a 2xx non-GET; always best-effort.
const inboxBustAfterWrite: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  if (c.req.method === "GET") return;
  if (c.res.status >= 200 && c.res.status < 300) {
    const uid = c.get("user")?.id;
    if (uid != null) await bustInboxForUser(c.env, uid);
  }
};

// Outermost: one structured access-log line + X-Request-Id per request.
app.use("*", requestLog);

app.use("*", cors());

// D1 -> Supabase cutover: swap env.DB for the Postgres-backed shim on every
// request, before auth + routes. Remove once all paths use Drizzle/postgres.js.
app.use("*", dbInject);

app.get("/", (c) => c.json({ ok: true, service: "autocount-sync-api" }));
app.get("/health", (c) => c.json({ ok: true }));

// /api/auth/* is unauthenticated (login, bootstrap, accept-invite, status,
// me, logout). It must be mounted BEFORE the auth middleware below.
app.route("/api/auth", authRoutes);

// Public customer survey — unauthenticated, token-based. Lives under
// /api/survey (not /survey) so it doesn't collide with the SPA route
// at /survey/:token. The SPA page fetches from /api/survey.
app.route("/api/survey", survey);

// Customer Portal — tokenised per-case tracking.
//   POST /api/track               public: verify ASSR no + phone
//   /api/portal/*   (caseTrack)   single-case scoped API
// Both live under /api so the existing /api/* rewrite in _redirects
// forwards them correctly, and they never collide with SPA paths
// like /track or /portal/case/:token.
app.route("/api/track", track);
app.use("/api/portal/*", caseTrack);
app.route("/api/portal", portal);

// Supplier portal — same shape as customer portal, different middleware.
app.use("/api/supplier-portal/*", supplierTrack);
app.route("/api/supplier-portal", supplierPortal);

// Mail Center inbound ingest — PRE-AUTH, secret-guarded machine-to-machine.
// MUST be mounted BEFORE the /api/* auth gate so the standalone inbound Worker
// (no staff session) can POST received mail. It authenticates the caller with
// the x-mail-secret header vs env.MAIL_INBOUND_SECRET and 503s until that secret
// is set. Mounted at the exact sub-path so the authed mail-center router below
// never shadows it.
app.route("/api/mail-center/inbound", mailInbound);
// 2990 live SO mirror — pre-auth, secret-guarded (x-sync-secret == SYNC_SECRET).
app.route("/api/sync/so-mirror", soMirror);
// POS auth — pin-login + sales-staff are PRE-AUTH (before the /api/* gate);
// set-pin/verify-pin/sales-stats re-apply `auth` inside the router.
app.route("/api/pos", pos);

// Google Form intake webhook — PRE-AUTH like mail-inbound: called by
// Google Apps Script (no staff session), self-guarded by the
// FORM_INTAKE_KEY shared secret (X-Intake-Key header). Was mounted
// below the gate at first, so every call 401'd at the gate before the
// route's own key check ever ran.
app.route("/api/assr-form-intake", assrFormIntake);

// Auth gate for everything else under /api/*. Mounted AFTER the
// public API routes above so they stay unauthenticated.
app.use("/api/*", auth);

// Opt-in request idempotency (no-op unless the client sends an
// `Idempotency-Key` header). Mounted after auth so `userId` is set, and
// before the routes so it can replay a stored response. Fail-open.
app.use("/api/*", idempotency);

// Multi-company (Phase 0b): resolve the ACTIVE company + allowed companies per
// request (X-Company-Id switcher header / hostname default) and stash them on
// the context, so BOTH the SCM query-scoping helpers (scm/lib/companyScope.ts)
// AND the native raw-SQL modules (sales / finance) can filter + stamp
// company_id. Mounted on the whole authenticated /api/* surface: after auth +
// idempotency, before every route. Reads only request headers + the companies
// master, so native routes without any company table simply ignore
// c.get('companyId'), and it DEGRADES SAFELY (leaves companyId undefined) when
// the companies master isn't resolvable yet — so single-company Houzs keeps
// serving unchanged and the pre-auth public routes above are untouched.
app.use("/api/*", companyContext);

// Inbox snapshot self-heal — the /api/inbox GET caches a per-user aggregate of
// ASSR + Projects + Trips for ~60s. After the acting user makes a successful
// write to ASSR or Projects, bust THEIR snapshot so their own inbox reflects it
// on the next load instead of staying stale for up to a minute. Best-effort and
// post-response: never blocks or fails the write. Scoped to /api/assr + /api/
// projects only, where c.get("user") is the Houzs bigint user that keys the
// snapshot; the /api/scm/* trip routes carry the scm.staff UUID (see the
// staff-UUID bigint trap), so their inbox slice stays on the 60s TTL. Cross-
// user staleness (items assigned to others) is likewise intentionally on TTL.
app.use("/api/assr/*", inboxBustAfterWrite);
app.use("/api/projects/*", inboxBustAfterWrite);

// Mount the Lead Time Portal first so /api/assr/portal/* doesn't
// fall through into the catch-all /:id handler on the main module.
app.route("/api/assr/portal", assrPortal);
app.route("/api/assr", assr);
app.route("/api/logs", logs);
app.route("/api/audit", auditRoutes);
app.route("/api/admin/health", systemHealthRoutes);
app.route("/api/udf", udf);
app.route("/api/totp", totpRoutes);
app.route("/api/users", users);
app.route("/api/roles", roles);
app.route("/api/positions", positions);
app.route("/api/departments", departments);
app.route("/api/companies", companies);
app.route("/api/notifications", notifications);
app.route("/api/presence", presence);
app.route("/api/events", events);
app.route("/api/projects", projects);
app.route("/api/sales", sales);
app.route("/api/finance", finance);
app.route("/api/stockitems", stockItems);
app.route("/api/fleet", fleet);
app.route("/api/settings", settings);
app.route("/api/branding", branding);
app.route("/api/inbox", inbox);
// Mail Center (authed) — reads/reply/compose/label gate on mailbox SCOPE
// ownership; alias/access/scope-level admin gate on mail_center.manage inside
// the handlers (owner passes via "*"). The pre-auth /api/mail-center/inbound
// route is mounted above, before the auth gate, and is not shadowed by this.
app.route("/api/mail-center", mailCenter);
// Announcements — the banner GET + ack POST are open to every authed user
// (the route handles it internally); list/CRUD/remind/acks-readout are
// announcements.read / announcements.write gated.
app.route("/api/announcements", announcements);
// Agent Console — owner-only (requirePermission("*") inside the router).
// Deliberately in the public /api tree, NOT /api/scm (the scm subtree swaps
// c.get('user') to scm.staff UUIDs — the known staff-UUID bigint trap).
app.route("/api/agents", agentConsole);
app.route("/api/projects-print", projectsPrint);
app.route("/api/search", search);
app.route("/api/assr-print", assrPrint);

// ── Ported 2990's SCM (furniture supply chain) — /api/scm/* ──────────
// Gated on scm.access (Owner / IT Admin pass via their "*" wildcard). The
// routes attach their own scm-scoped supabase client via scm/middleware/auth.
// requireScmAccess is ADDITIVE: it keeps the exact "*"/"scm.access" pass
// conditions AND also lets a position pass when it has ANY scm* page-access
// area granted at >= view — so per-position SCM grants work without removing
// any existing user's access. (Was requireAnyPermission(["*","scm.access"]).)
app.use("/api/scm/*", requireScmAccess);
app.route("/api/scm", scmApp);

// Map raw infrastructure errors to operator-friendly messages so staff never
// see a Postgres/driver string (e.g. the "operator does not exist: date < text"
// or "CONNECTION_CLOSED" leaks seen during the cutover). Full error still goes
// to wrangler tail for us. HTTPException (thrown with an intended status) passes
// through untouched.
function humanizeError(err: Error): { status: 500 | 503; message: string } {
  const m = String(err?.message ?? err);
  // Transient connection failures (cold-start hang, pooler connection cap,
  // dropped/reaped socket, cross-context I/O) -> 503 "try again". Shares ONE
  // matcher with the retry layer (d1-compat TRANSIENT_CONN_RE) so the two can
  // never drift apart, and the frontend retries idempotent GETs on 503 — so
  // these self-heal instead of surfacing as a dead-end "Something went wrong".
  if (TRANSIENT_CONN_RE.test(m))
    return { status: 503, message: "The database is briefly unavailable. Please try again in a moment." };
  if (/operator does not exist|column .* does not exist|relation .* does not exist|syntax error|invalid input syntax|violates .* constraint|duplicate key/i.test(m))
    return { status: 500, message: "Something went wrong processing that request. Please try again." };
  return { status: 500, message: "Something went wrong. Please try again." };
}

app.onError((err, c) => {
  console.error("[onError]", err);
  // Preserve Hono HTTPException status/body (intentional 4xx from handlers).
  const anyErr = err as Error & { getResponse?: () => Response; status?: number };
  const base =
    typeof anyErr.getResponse === "function"
      ? anyErr.getResponse()
      : (() => {
          const { status, message } = humanizeError(err);
          return c.json({ error: message }, status);
        })();
  // The cors() middleware sets Access-Control-Allow-Origin in its post-next()
  // pass, which is SKIPPED when a handler throws — so error responses would
  // otherwise reach the browser WITHOUT CORS headers and surface as an opaque
  // "Failed to fetch" instead of the real status/message. Re-add them here so
  // every error is readable by the SPA. (Matches cors() default origin "*".)
  const res = new Response(base.body, base);
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Cutover: cron services write via env.DB too — point it at Postgres.
    env = withPgDb(env);
    if (event.cron === "*/5 * * * *") {
      // Keep-warm: a trivial DB ping every 5 min keeps the Hyperdrive pool
      // alive through quiet periods so the first real request never hits a
      // reaped/cold connection. Cheap — SELECT 1.
      ctx.waitUntil(
        env.DB.prepare("SELECT 1 AS ok").first().catch((e) => console.error("[cron keepwarm]", e))
      );
      // Durable email: retry outbox rows whose immediate send failed. No-op
      // without RESEND_API_KEY; bounded to 25 rows / 3 attempts so a bad batch
      // can't stall the slot.
      ctx.waitUntil(
        drainEmailOutbox(env)
          .then((r) => {
            if (r.processed) console.log(`[cron email-outbox] processed=${r.processed} sent=${r.sent} failed=${r.failed}`);
          })
          .catch((e) => console.error("[cron email-outbox]", e))
      );
    } else if (event.cron === "*/30 * * * *") {
      // ASSR/QMS v3.1 — per-stage alert scanner (half / approaching / breach).
      // Cheap: one query over open stage_history rows, idempotent via the
      // alerts_fired bit-mask.
      ctx.waitUntil(
        runAssrAlerts(env)
          .then((r) =>
            console.log(
              `[cron assr-alerts] scanned=${r.cases_scanned} half=${r.half} appr=${r.approaching} breach=${r.breach}`
            )
          )
          .catch((e) => console.error("[cron assr-alerts]", e))
      );
      // Lead-time scheduled activations (mig 080). Cheap: one indexed SELECT
      // for pending rows whose scheduled_for is past.
      ctx.waitUntil(
        runScheduledLeadTimeActivations(env)
          .then((r) => {
            if (r.fired > 0) console.log(`[cron lead-time-schedule] fired=${r.fired}`);
          })
          .catch((e) => console.error("[cron lead-time-schedule]", e))
      );
      // Agent heartbeat — the agents decide their own cadence (scheduler's
      // >=1h min-gap makes this an effective hourly beat). No-op until an
      // engine registers; kill switch / pause honoured inside. Best-effort:
      // a heartbeat failure can never break the other crons.
      ctx.waitUntil(
        runAgentHeartbeat(env)
          .then((r) => {
            if (r.ran.length)
              console.log(
                `[cron agent-heartbeat] ran=${r.ran.map((x) => x.task).join(",")} skipped=${r.skipped.length}`
              );
          })
          .catch((e) => console.error("[cron agent-heartbeat]", e))
      );
      // Keep-warm the scan-SO catalog prompt-cache during Malaysia business
      // hours (UTC+8 ~08:00–22:00 → UTC hour 0–13) so the shared Anthropic
      // cache rarely goes cold between showroom scans. Fires the SAME minimal
      // warm call /scan-so/warm uses (byte-identical cachedPrefix). Skips
      // gracefully when ANTHROPIC_API_KEY is unset; try/catch so a warm failure
      // can never break the scheduled handler.
      {
        const h = new Date(event.scheduledTime).getUTCHours();
        if (h >= 0 && h < 14 && env.ANTHROPIC_API_KEY) {
          ctx.waitUntil(
            warmCatalogCacheForCron(env)
              .then((r) => console.log(`[cron scan-so warm] ${JSON.stringify(r)}`))
              .catch((e) => console.error("[cron scan-so warm]", e)),
          );
        }
      }
    } else if (event.cron === "0 2 * * *") {
      // Daily 02:00 UTC slot: SLA escalation + ASSR digest + project reminders.
      ctx.waitUntil(
        runSlaEscalation(env)
          .then((r) => console.log(`[cron sla] escalated ${r.escalated} case(s)`))
          .catch((e) => console.error("[cron sla]", e))
      );
      ctx.waitUntil(
        runAssrDailyDigest(env)
          .then((r) => console.log(`[cron assr-digest] sent=${r.recipients} cases=${r.cases}`))
          .catch((e) => console.error("[cron assr-digest]", e))
      );
      ctx.waitUntil(
        runProjectDueReminders(env)
          .then((r) =>
            console.log(
              `[cron proj-reminders] ${r.items} item(s) across ${r.recipients} recipient(s), ${r.sent} email(s) sent`
            )
          )
          .catch((e) => console.error("[cron proj-reminders]", e))
      );
      // Idempotency-key TTL sweep. Keys only need to outlive a client's retry
      // window; 24h is generous. Cheap (indexed on created_at).
      ctx.waitUntil(
        env.DB.prepare(
          `DELETE FROM idempotency_keys WHERE created_at < datetime('now','-24 hours')`,
        )
          .run()
          .then((r) => {
            const n = r?.meta?.changes ?? 0;
            if (n) console.log(`[cron idempotency-sweep] purged ${n} expired key(s)`);
          })
          .catch((e) => console.error("[cron idempotency-sweep]", e)),
      );
      // Weekly: re-distill every salesperson's scan-so OCR rules + the
      // __GLOBAL__ alias dictionary. Reuses the daily 02:00 slot, gated to
      // Sundays so it runs once a week without a dedicated cron trigger.
      // distillAllSalespersonRules cheap-skips reps with <2 samples and returns
      // a graceful error result when ANTHROPIC_API_KEY is unset — log + swallow
      // so a distill failure can never break the scheduled handler.
      if (new Date(event.scheduledTime).getUTCDay() === 0) {
        ctx.waitUntil(
          (async () => {
            try {
              const branding = await getBranding(env);
              const summary = await distillAllSalespersonRules(
                getSupabaseService(env),
                env.ANTHROPIC_API_KEY,
                branding.companyName,
              );
              console.log("[scan-so weekly distill]", JSON.stringify(summary));
            } catch (e) {
              console.error("[scan-so weekly distill]", e);
            }
          })(),
        );
      }
    }
  },
  // Cloudflare Queue consumer for the background scan-so OCR pipeline (queue
  // `houzs-scan-ocr`, DLQ `houzs-scan-ocr-dlq`). max_batch_size = 1, so each
  // batch is one job. A queue-owned attempt survives isolate eviction — the
  // reliability fix for the old waitUntil pipeline. On success ack; on failure
  // retry (up to max_retries in wrangler.toml, then the message lands in the
  // DLQ and the read-time reaper marks it stale as a final backstop).
  async queue(batch: MessageBatch<{ jobId: string }>, env: Env, _ctx: ExecutionContext) {
    // Mirror the scheduled handler: the consumer writes via env.DB too, so
    // point it at Postgres.
    env = withPgDb(env);
    for (const msg of batch.messages) {
      try {
        await processScanQueueMessage(env, msg.body.jobId);
        msg.ack();
      } catch (e) {
        console.error("[scan-queue]", msg.body?.jobId, e);
        msg.retry();
      }
    }
  },
};
