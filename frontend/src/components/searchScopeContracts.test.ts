import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = (relative: string) =>
  readFileSync(resolve(process.cwd(), "src", relative), "utf8");

describe("list search scope contracts", () => {
  test.each([
    ["pages/scm-v2/Amendments.tsx", 500],
    ["pages/scm-v2/PaymentVouchers.tsx", 500],
    ["pages/scm-v2/Accounting.tsx", 500],
    ["pages/scm-v2/PurchaseConsignmentReturns.tsx", 300],
    ["pages/scm-v2/PurchaseConsignmentOrders.tsx", 1000],
    ["pages/scm-v2/PurchaseConsignmentReceives.tsx", 1000],
    ["pages/scm-v2/ProductModels.tsx", 1000],
  ])("declares the loaded-only upstream cap for %s", (file, limit) => {
    expect(source(file)).toContain(`loadedSearchLimit={${limit}}`);
  });

  test.each([
    ["pages/scm-v2/DeliveryReturnsListV2.tsx", 500],
    ["pages/scm-v2/PurchaseReturnsListV2.tsx", 300],
  ])("declares the loaded-only cap on custom and DataTable search for %s", (file, limit) => {
    const contents = source(file);
    expect(contents).toContain(`loadedLimit: ${limit}`);
    expect(contents).toContain(`loadedLimit={${limit}}`);
  });

  test("does not promise joined fields that the current server search cannot query", () => {
    expect(source("pages/scm-v2/GoodsReceivedListV2.tsx")).not.toMatch(/Search GRN[^\n]*(supplier|PO)/i);
    expect(source("pages/scm-v2/PurchaseOrdersListV2.tsx")).not.toMatch(/Search PO[^\n]*supplier/i);
    expect(source("pages/scm-v2/PurchaseInvoicesListV2.tsx")).not.toMatch(/Search PI[^\n]*(supplier, source|supplier and source)/i);
  });
});
