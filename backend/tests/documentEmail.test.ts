import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { documentEmailHtml, sendEmail } from "../src/services/email";
import { buildDeliveryOrderEmail, type DoEmailRow } from "../src/scm/lib/do-email";

// Document-email TEMPLATE + customer-channel gating (mig 098/0009) + the
// Delivery Order message builder.
//
// History, because it explains the shape of this file: the auto-send features
// (delivery order / invoice / report) shipped fully wired on 2026-06-14
// (e7654e4) against the CORE delivery module, and the strip-to-core cutover
// (dfa1111) then deleted that module — services/delivery.ts took the trigger,
// the guard and 8 of these tests with it, leaving only the template + gating.
// feat/r1-do-email re-wires the DO half onto the LIVE document (scm.
// delivery_orders); scm/lib/do-email.ts is its home.
//
// buildDeliveryOrderEmail is pure (row -> message | null), so it is tested
// directly here — the same split so-delivery-sync.ts uses for isSoFullyCovered.
// maybeSendDeliveryOrderEmail's claim/stamp path needs a PostgREST client and is
// not covered here; the gate it depends on IS (fail-closed, below). Resend is
// mocked.

const doRow = (over: Partial<DoEmailRow> = {}): DoEmailRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  company_id: 1,
  do_number: "DO-2607-001",
  email: "cust@example.com",
  debtor_name: "ACME Sdn Bhd",
  do_email_sent_at: null,
  address1: "12 Jalan Satu",
  address2: null,
  city: "Petaling Jaya",
  postcode: "47800",
  state: "Selangor",
  customer_delivery_date: "2026-07-20",
  expected_delivery_at: null,
  driver_name: "Ah Meng",
  vehicle: "WXY 1234",
  ...over,
});

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as typeof env;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_log`);
  await env.DB.exec(`DELETE FROM email_outbox`);
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

describe("delivery order email builder", () => {
  test("no recipient => null (never an error; the goods still ship)", () => {
    expect(buildDeliveryOrderEmail(doRow({ email: null }), "Houzs Century")).toBeNull();
    expect(buildDeliveryOrderEmail(doRow({ email: "   " }), "Houzs Century")).toBeNull();
    // Garbage that isn't an address must not reach the provider either.
    expect(buildDeliveryOrderEmail(doRow({ email: "not-an-address" }), "Houzs Century")).toBeNull();
  });

  test("renders the DO number, recipient, address, schedule and crew", () => {
    const msg = buildDeliveryOrderEmail(doRow(), "Houzs Century")!;
    expect(msg.to).toBe("cust@example.com");
    expect(msg.subject).toBe("Houzs Century — Delivery Order DO-2607-001");
    expect(msg.html).toContain("DO-2607-001");
    expect(msg.html).toContain("ACME Sdn Bhd");
    expect(msg.html).toContain("12 Jalan Satu, Petaling Jaya, 47800, Selangor");
    expect(msg.html).toContain("2026-07-20");
    expect(msg.html).toContain("Ah Meng");
    expect(msg.html).toContain("WXY 1234");
  });

  test("falls back to the expected date, then to 'To be confirmed'", () => {
    const viaExpected = buildDeliveryOrderEmail(
      doRow({ customer_delivery_date: null, expected_delivery_at: "2026-07-22" }),
      "Houzs Century",
    )!;
    expect(viaExpected.html).toContain("2026-07-22");
    const neither = buildDeliveryOrderEmail(
      doRow({ customer_delivery_date: null, expected_delivery_at: null }),
      "Houzs Century",
    )!;
    expect(neither.html).toContain("To be confirmed");
  });

  test("omits crew rows it has no data for (no empty 'Driver:' line)", () => {
    const msg = buildDeliveryOrderEmail(
      doRow({ driver_name: null, vehicle: null }),
      "Houzs Century",
    )!;
    expect(msg.html).not.toContain("Driver");
    expect(msg.html).not.toContain("Lorry");
  });

  test("carries the company identity into the subject and body (2990 DO)", () => {
    // escapeHtml escapes & < > " and deliberately NOT ' — so the apostrophe
    // rides through literally. Asserted as-is rather than as an entity.
    const msg = buildDeliveryOrderEmail(doRow({ company_id: 2 }), "2990's Home")!;
    expect(msg.subject).toBe("2990's Home — Delivery Order DO-2607-001");
    expect(msg.html).toContain("2990's Home");
  });

  test("a customer name carrying markup is escaped, not interpolated raw", () => {
    const msg = buildDeliveryOrderEmail(
      doRow({ debtor_name: '<script>alert(1)</script>' }),
      "Houzs Century",
    )!;
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });
});

describe("customer channel gating", () => {
  test("a customer channel FAILS CLOSED when the toggle row is missing", async () => {
    // A missing customer-channel toggle must resolve to OFF (never auto-email a
    // real customer on a fresh/restored DB). The toggles are still surfaced by
    // the Settings email page.
    await env.DB.exec(`DELETE FROM app_settings WHERE key='email.delivery_order'`);
    const res = await sendEmail(liveEnv, {
      to: "cust@example.com",
      subject: "x",
      html: "<p>x</p>",
      purpose: "delivery_order",
    });
    expect(res.status).toBe("skipped");
  });
});
