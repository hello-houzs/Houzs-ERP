import { describe, expect, test } from "vitest";

describe("security-upgraded document dependencies", () => {
  test("jsPDF and AutoTable still generate a non-empty document", async () => {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const doc = new jsPDF();
    doc.text("Houzs ERP", 14, 14);
    autoTable(doc, {
      head: [["Document", "Status"]],
      body: [["SO-TEST", "Draft"]],
    });

    const bytes = doc.output("arraybuffer");
    expect(bytes.byteLength).toBeGreaterThan(500);
  });

  test("SheetJS 0.20.x writes and reads the export/import contract", async () => {
    const XLSX = await import("./xlsx-runtime");
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Code", "Quantity"],
      ["SKU-TEST", 3],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Items");
    const bytes = XLSX.writeXLSX(workbook, { type: "array" });
    const parsed = XLSX.read(bytes, { type: "array" });

    expect(parsed.SheetNames).toEqual(["Items"]);
    expect(XLSX.utils.sheet_to_json(parsed.Sheets["Items"]!, { header: 1 }))
      .toEqual([["Code", "Quantity"], ["SKU-TEST", 3]]);
  });
});
