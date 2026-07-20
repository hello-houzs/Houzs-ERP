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

  test.each([
    "pages/scm-v2/StockTakesListV2.tsx",
    "pages/scm-v2/StockTransfersListV2.tsx",
    "pages/scm-v2/UnbilledDeliveriesV2.tsx",
  ])("declares complete accessible-result search for %s", (file) => {
    expect(source(file)).toContain('scope: "server"');
  });

  test("reports mobile module endpoint caps instead of implying global search", () => {
    const contents = source("mobile/MobileModuleList.tsx");
    expect(contents).toContain('endpoint: "/delivery-returns?limit=500&');
    expect(contents).toContain('endpoint: "/purchase-returns?limit=300&');
    expect(contents).toContain("loadedLimit={loadedSearchLimit}");
  });

  test("reports the mobile conversion source cap", () => {
    const contents = source("mobile/MobileConvertWizard.tsx");
    expect(contents.match(/limit=200/g)).toHaveLength(3);
    expect(contents).toContain('scope="loaded"');
    expect(contents).toContain("loadedLimit={200}");
  });

  test("separates complete inventory product search from capped lot-derived batches", () => {
    const contents = source("pages/scm-v2/Inventory.tsx");
    expect(contents).toContain('scope="server"');
    expect(contents).toContain("Searches batches assembled from up to 1,000 loaded lot rows only");
    expect(contents).toContain("searchTransition.resultsAreStale || isPlaceholderData");
    expect(contents).toContain("resultsAreStale ? [] : rows");
  });
});
