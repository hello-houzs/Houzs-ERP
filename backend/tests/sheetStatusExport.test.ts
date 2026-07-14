import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import intake from "../src/routes/assrFormIntake";

// Sheet status export (Nick 2026-07-14) — the HC Delivery sheet's Apps
// Script pulls this every 10 minutes to rewrite its ASSR STATUS column.
// Pins the X-Intake-Key guard and the stage → sheet-vocabulary mapping
// (the sheet's stats block counts these exact strings).

const KEY = "test-sheet-sync-key";
const authedEnv = { ...env, FORM_INTAKE_KEY: KEY } as typeof env;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM assr_cases WHERE id IN (9101, 9102)`).run();
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, ref_no, stage)
     VALUES (9101, 'ASSR/TEST-9101', 'SO-TEST-9101', 'HCTEST01', 'pending_supplier_pickup')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage, archived_at)
     VALUES (9102, 'ASSR/TEST-9102', 'SO-TEST-9102', 'completed', datetime('now'))`
  ).run();
});

describe("GET /status-export", () => {
  test("rejects a wrong key with 401", async () => {
    const res = await intake.request(
      "/status-export",
      { headers: { "X-Intake-Key": "wrong" } },
      authedEnv
    );
    expect(res.status).toBe(401);
  });

  test("returns sheet-vocabulary statuses for live cases and skips archived", async () => {
    const res = await intake.request(
      "/status-export",
      { headers: { "X-Intake-Key": KEY } },
      authedEnv
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; cases: any[] };
    const mine = body.cases.find((c) => c.assr_no === "ASSR/TEST-9101");
    expect(mine).toBeTruthy();
    expect(mine.so_no).toBe("SO-TEST-9101");
    expect(mine.ref_no).toBe("HCTEST01");
    // "Pending Supplier Pickup" — the exact string the sheet's stats
    // block counts.
    expect(mine.status).toBe("Pending Supplier Pickup");
    expect(body.cases.find((c) => c.assr_no === "ASSR/TEST-9102")).toBeUndefined();
  });
});
