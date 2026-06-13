import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  buildDeliveryOrderEmail,
  maybeSendDeliveryOrderEmail,
} from "../src/services/delivery";
import { documentEmailHtml, sendEmail, setSetting } from "../src/services/email";

// Auto-send customer documents (mig 098/0009). The 'delivery_order' channel
// FAILS CLOSED (missing row = OFF), the send no-ops without a customer_email,
// and delivery_tracking.do_email_sent_at makes it once-only. No status hook is
// wired yet (trigger TBD); maybeSendDeliveryOrderEmail is the ready primitive.
// Resend is mocked.

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

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_log`);
  await env.DB.exec(`DELETE FROM email_outbox`);
  await env.DB.exec(`DELETE FROM delivery_tracking`);
  await env.DB.exec(`DELETE FROM sales_orders`);
  await setChannel(false); // each test starts gated OFF (the safe default)
});

describe("document email template", () => {
  test("renders the doc no, recipient, and every row", () => {
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
  });

  test("escapes HTML metacharacters in interpolated values (no markup injection)", () => {
    const html = documentEmailHtml({
      docTypeLabel: "Delivery Order",
      docNo: "SO-1",
      recipientName: 'ACME <b>&"x',
      rows: [{ label: "Note", value: "<script>alert(1)</script> & more" }],
    });
    // Raw customer markup must NOT survive into the email body.
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    // Escaped forms are present instead.
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
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

describe("gating + send", () => {
  test("channel FAILS CLOSED when the toggle row is missing", async () => {
    // Remove the seeded row entirely: a missing customer-channel toggle must
    // resolve to OFF (never auto-email a real customer on a fresh/restored DB).
    await env.DB.exec(`DELETE FROM app_settings WHERE key='email.delivery_order'`);
    const res = await sendEmail(liveEnv, {
      to: "cust@example.com",
      subject: "x",
      html: "<p>x</p>",
      purpose: "delivery_order",
    });
    expect(res.status).toBe("skipped");
  });

  test("channel OFF: maybeSend skips, nothing queued, guard stays null", async () => {
    await seedOrder("SO-OFF", "WEST", "cust@example.com");
    await maybeSendDeliveryOrderEmail(env, "SO-OFF");

    const el = await env.DB.prepare(
      `SELECT status FROM email_log WHERE purpose='delivery_order' ORDER BY id DESC LIMIT 1`,
    ).first<{ status: string }>();
    expect(el?.status).toBe("skipped");

    const ob = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_outbox WHERE purpose='delivery_order'`,
    ).first<{ n: number }>();
    expect(Number(ob?.n ?? 0)).toBe(0);

    const dt = await env.DB.prepare(
      `SELECT do_email_sent_at FROM delivery_tracking WHERE doc_no='SO-OFF'`,
    ).first<{ do_email_sent_at: string | null }>();
    expect(dt?.do_email_sent_at).toBeNull();
  });

  test("channel ON: emails the customer once and stamps the guard", async () => {
    await setChannel(true);
    mockResend(200, { id: "prov-do" });
    await seedOrder("SO-ON", "WEST", "cust@example.com");

    await maybeSendDeliveryOrderEmail(liveEnv, "SO-ON");

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

  test("dedup: a second send attempt does not re-send", async () => {
    await setChannel(true);
    mockResend(200, { id: "prov-once" }); // exactly one send expected
    await seedOrder("SO-DUP", "WEST", "cust@example.com");

    await maybeSendDeliveryOrderEmail(liveEnv, "SO-DUP");
    // Guard now set; a retry must NOT fetch again (no 2nd interceptor → if it
    // tried, disableNetConnect would throw and fail the test).
    await maybeSendDeliveryOrderEmail(liveEnv, "SO-DUP");

    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_log WHERE purpose='delivery_order' AND status='sent'`,
    ).first<{ n: number }>();
    expect(Number(n?.n ?? 0)).toBe(1);
  });
});
