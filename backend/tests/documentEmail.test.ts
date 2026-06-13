import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  advanceStatus,
  buildDeliveryOrderEmail,
  maybeSendDeliveryOrderEmail,
} from "../src/services/delivery";
import { documentEmailHtml, setSetting } from "../src/services/email";

// Auto-send customer documents (mig 098/0009). The 'delivery_order' channel is
// seeded OFF, the send no-ops without a customer_email, and delivery_tracking
// .do_email_sent_at makes it once-only. The dispatch hook lives in advanceStatus
// (region-aware: WEST/EAST 'out_for_delivery', SG 'shipped'). Resend is mocked.

function mockResend(status: number, body: unknown) {
  fetchMock
    .get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(status, body as any);
}

async function seedOrder(docNo: string, region: string, email: string | null) {
  await env.DB.prepare(
    `INSERT INTO sales_orders (doc_no, region, debtor_name, customer_email, inv_addr1, local_total)
     VALUES (?, ?, 'ACME Sdn Bhd', ?, '12 Jalan Test', 5000)`,
  )
    .bind(docNo, region, email)
    .run();
  await env.DB.prepare(
    `INSERT INTO delivery_tracking (doc_no, region, status, do_ready_at)
     VALUES (?, ?, 'do_ready', datetime('now'))`,
  )
    .bind(docNo, region)
    .run();
}

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as typeof env;

async function setChannel(on: boolean) {
  await setSetting(env, "email.delivery_order", { value: on }, null);
}

// A real user id for delivery_status_log.changed_by (FK to users).
let actorId: number;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_log`);
  await env.DB.exec(`DELETE FROM email_outbox`);
  await env.DB.exec(`DELETE FROM delivery_status_log`);
  await env.DB.exec(`DELETE FROM delivery_tracking`);
  await env.DB.exec(`DELETE FROM sales_orders`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);

  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'test', ?, 0)`,
  )
    .bind(`r_${Math.random().toString(36).slice(2)}`, JSON.stringify(["*"]))
    .run();
  const u = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, 'Dispatcher', ?, 'active', datetime('now'))`,
  )
    .bind(`u_${Math.random().toString(36).slice(2)}@test.local`, role.meta.last_row_id)
    .run();
  actorId = u.meta.last_row_id as number;

  await setChannel(false); // each test starts gated OFF (the safe default)
});

describe("document email template", () => {
  test("documentEmailHtml renders the doc no, recipient, and every row; no null leaks", () => {
    const html = documentEmailHtml({
      docTypeLabel: "Delivery Order",
      docNo: "SO-1",
      recipientName: "ACME Sdn Bhd",
      rows: [
        { label: "Order No", value: "SO-1" },
        { label: "Time", value: "9am - 12pm" },
      ],
      note: "On its way",
    });
    expect(html).toContain("Delivery Order SO-1");
    expect(html).toContain("ACME Sdn Bhd");
    expect(html).toContain("9am - 12pm");
    expect(html).toContain("On its way");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });
});

describe("buildDeliveryOrderEmail", () => {
  test("returns null when the order has no customer_email", async () => {
    await seedOrder("SO-NOEMAIL", "WEST", null);
    expect(await buildDeliveryOrderEmail(env, "SO-NOEMAIL")).toBeNull();
  });

  test("builds a message addressed to the customer when an email exists", async () => {
    await seedOrder("SO-EMAIL", "WEST", "cust@example.com");
    const msg = await buildDeliveryOrderEmail(env, "SO-EMAIL");
    expect(msg?.to).toBe("cust@example.com");
    expect(msg?.subject).toContain("SO-EMAIL");
    expect(msg?.html).toContain("ACME Sdn Bhd");
    expect(msg?.html).toContain("12 Jalan Test");
  });

  test("unknown doc is a safe no-op (never throws)", async () => {
    await expect(maybeSendDeliveryOrderEmail(env, "DOES-NOT-EXIST")).resolves.toBeUndefined();
  });
});

describe("dispatch hook (gated)", () => {
  test("channel OFF: dispatch still advances + logs, but nothing is sent", async () => {
    await seedOrder("SO-OFF", "WEST", "cust@example.com");
    const r = await advanceStatus(env, "SO-OFF", "out_for_delivery", actorId);
    expect(r.to).toBe("out_for_delivery");

    // The durable mutation succeeded.
    const log = await env.DB.prepare(
      `SELECT to_status FROM delivery_status_log WHERE doc_no = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind("SO-OFF")
      .first<{ to_status: string }>();
    expect(log?.to_status).toBe("out_for_delivery");

    // Email was attempted but skipped because the channel is disabled.
    const el = await env.DB.prepare(
      `SELECT status FROM email_log WHERE purpose='delivery_order' ORDER BY id DESC LIMIT 1`,
    ).first<{ status: string }>();
    expect(el?.status).toBe("skipped");

    // No outbox row (skip happens before enqueue) and the guard stays null so a
    // future "channel ON" dispatch can still notify.
    const ob = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_outbox WHERE purpose='delivery_order'`,
    ).first<{ n: number }>();
    expect(Number(ob?.n ?? 0)).toBe(0);
    const dt = await env.DB.prepare(
      `SELECT do_email_sent_at FROM delivery_tracking WHERE doc_no='SO-OFF'`,
    ).first<{ do_email_sent_at: string | null }>();
    expect(dt?.do_email_sent_at).toBeNull();
  });

  test("channel ON: dispatch emails the customer once and stamps the guard", async () => {
    await setChannel(true);
    mockResend(200, { id: "prov-do" });
    await seedOrder("SO-ON", "WEST", "cust@example.com");

    await advanceStatus(liveEnv, "SO-ON", "out_for_delivery", actorId);

    const el = await env.DB.prepare(
      `SELECT status, to_addr FROM email_log WHERE purpose='delivery_order' ORDER BY id DESC LIMIT 1`,
    ).first<{ status: string; to_addr: string }>();
    expect(el?.status).toBe("sent");
    expect(el?.to_addr).toBe("cust@example.com");

    const ob = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_outbox WHERE purpose='delivery_order' AND status='sent'`,
    ).first<{ n: number }>();
    expect(Number(ob?.n ?? 0)).toBe(1);

    const dt = await env.DB.prepare(
      `SELECT do_email_sent_at FROM delivery_tracking WHERE doc_no='SO-ON'`,
    ).first<{ do_email_sent_at: string | null }>();
    expect(dt?.do_email_sent_at).toBeTruthy();
  });

  test("dedup: a second dispatch attempt does not re-send", async () => {
    await setChannel(true);
    mockResend(200, { id: "prov-once" }); // exactly one send expected
    await seedOrder("SO-DUP", "WEST", "cust@example.com");

    await maybeSendDeliveryOrderEmail(liveEnv, "SO-DUP");
    // Guard now set; a retried dispatch must NOT fetch again (no 2nd interceptor
    // → if it tried, disableNetConnect would throw and fail the test).
    await maybeSendDeliveryOrderEmail(liveEnv, "SO-DUP");

    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_log WHERE purpose='delivery_order' AND status='sent'`,
    ).first<{ n: number }>();
    expect(Number(n?.n ?? 0)).toBe(1);
  });

  test("region trigger: SG fires on 'shipped', not 'pending_shipout'", async () => {
    await setChannel(true);
    await seedOrder("SO-SG", "SG", "cust@example.com");

    // do_ready -> pending_shipout is NOT the dispatch milestone for SG: no send.
    await advanceStatus(liveEnv, "SO-SG", "pending_shipout", actorId);
    let dt = await env.DB.prepare(
      `SELECT do_email_sent_at FROM delivery_tracking WHERE doc_no='SO-SG'`,
    ).first<{ do_email_sent_at: string | null }>();
    expect(dt?.do_email_sent_at).toBeNull();

    // pending_shipout -> shipped IS the SG dispatch milestone: sends.
    mockResend(200, { id: "prov-sg" });
    await advanceStatus(liveEnv, "SO-SG", "shipped", actorId);
    dt = await env.DB.prepare(
      `SELECT do_email_sent_at FROM delivery_tracking WHERE doc_no='SO-SG'`,
    ).first<{ do_email_sent_at: string | null }>();
    expect(dt?.do_email_sent_at).toBeTruthy();
  });
});
