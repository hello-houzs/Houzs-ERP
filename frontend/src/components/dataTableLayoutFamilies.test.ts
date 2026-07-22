import { describe, expect, test } from "vitest";
import { DATA_TABLE_LAYOUT_FAMILIES } from "./dataTableLayoutFamilies";

describe("DataTable document-family layout manifest", () => {
  test("contains exactly eight unique, stable document family identities", () => {
    const keys = Object.values(DATA_TABLE_LAYOUT_FAMILIES);
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => !/\d/.test(key))).toBe(true);
  });
});
