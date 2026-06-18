import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { documentEmailHtml, sendEmail } from "../src/services/email";

// Document-email TEMPLATE + customer-channel gating (mig 098/0009). The
// per-document auto-send features (delivery order / invoice / report) were
// removed in the strip-to-core cutover; what remains and is exercised here is
// the shared email template plus the fail-closed gating that the Settings
// email-channel toggles still rely on. Resend is mocked.

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
