import { describe, it, expect } from "vitest";
import { toPgPlaceholders } from "./d1-compat";

describe("toPgPlaceholders", () => {
  it("rewrites sequential ? to $1,$2,...", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("handles adjacent placeholders in VALUES", () => {
    expect(toPgPlaceholders("INSERT INTO t (x,y) VALUES (?,?)")).toBe(
      "INSERT INTO t (x,y) VALUES ($1,$2)",
    );
  });

  it("leaves ? inside single-quoted literals alone", () => {
    expect(toPgPlaceholders("WHERE name = 'a?b' AND id = ?")).toBe(
      "WHERE name = 'a?b' AND id = $1",
    );
  });

  it("leaves ? inside double-quoted identifiers alone", () => {
    expect(toPgPlaceholders('WHERE j = "k?l" AND z = ?')).toBe(
      'WHERE j = "k?l" AND z = $1',
    );
  });

  it("counts only real placeholders across mixed quotes", () => {
    expect(
      toPgPlaceholders("a=? AND b='x' AND c=? AND d='?' AND e=?"),
    ).toBe("a=$1 AND b='x' AND c=$2 AND d='?' AND e=$3");
  });

  it("is a no-op when there are no placeholders", () => {
    expect(toPgPlaceholders("SELECT 1")).toBe("SELECT 1");
  });
});
