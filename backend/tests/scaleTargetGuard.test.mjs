import { describe, expect, test } from "vitest";
import { assertPgTarget, STAGING_ACK } from "../scripts/scale-target-guard.mjs";

describe("scale harness PostgreSQL target guard", () => {
  test.each([
    "postgres://user:pass@localhost/db",
    "postgres://user:pass@127.0.0.1/db",
    "postgres://user:pass@[::1]/db",
  ])("accepts local target %s without acknowledgement", (url) => {
    expect(assertPgTarget(url)).toBe(true);
  });

  test.each([
    "postgres://postgres:pass@db.minnapsemfzjmtvnnvdd.supabase.co/postgres",
    "postgres://postgres.minnapsemfzjmtvnnvdd:pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
  ])("accepts only the exact staging identity %s", (url) => {
    expect(assertPgTarget(url, STAGING_ACK)).toBe(false);
    expect(() => assertPgTarget(url)).toThrow(/Refusing a non-local/);
  });

  test.each([
    "postgres://review:pass@example.invalid/db?application_name=minnapsemfzjmtvnnvdd",
    "postgres://review:minnapsemfzjmtvnnvdd@example.invalid/db",
    "postgres://review:pass@example.invalid/minnapsemfzjmtvnnvdd",
    "postgres://postgres.minnapsemfzjmtvnnvdd:pass@example.invalid/db",
    "postgres://postgres:pass@db.unknown.supabase.co/postgres",
  ])("rejects a spoofed or unknown identity %s", (url) => {
    expect(() => assertPgTarget(url, STAGING_ACK)).toThrow(/Refusing a non-local/);
  });

  test.each([
    "postgres://postgres:pass@db.anogrigyjbduyzclzjgn.supabase.co/postgres",
    "postgres://postgres.anogrigyjbduyzclzjgn:pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
    "postgres://user:pass@erp.houzscentury.com/db",
  ])("always refuses the known production identity %s", (url) => {
    expect(() => assertPgTarget(url, STAGING_ACK)).toThrow(/known Houzs production/);
  });
});
