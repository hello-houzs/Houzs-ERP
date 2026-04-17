import { useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  useASSRCases,
  CASE_STATUS_LABELS, SERVICE_CATEGORY_LABELS,
  type ASSRCase,
} from "@/lib/assr-store";

// ─── Print-friendly Supplier Service Template ───────────────────────────────
// Shows: company header, ASSR ref, item details, problem description,
//        service issue photos, supplier pickup/ready dates, supplier remarks
// Hides: customer personal info (phone, address), internal notes, action taken logs, pricing

function fmt(d?: string) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "/");
}

export default function PrintSupplierPage() {
  const params = useParams<{ id: string }>();
  const caseId = decodeURIComponent(params.id!);
  const allCases = useASSRCases();
  const caseData = useMemo(() => allCases.find((c) => c.id === caseId), [allCases, caseId]);

  if (!caseData) {
    return <div className="p-8 text-center text-red-600 font-semibold">Case not found</div>;
  }

  const items = parseItems(caseData);

  return (
    <>
      <style>{printStyles}</style>
      <div className="print-page">
        {/* Header */}
        <div className="header-row">
          <div className="company-info">
            <div className="company-name">HOUZS CENTURY SDN. BHD.</div>
            <div className="company-reg">202201031135 (1476832-W)</div>
            <div className="company-addr">1831-B, Jalan KPB 1, Kawasan Perindustrian Balakong, 43300 Seri Kembangan, Selangor.</div>
          </div>
          <div className="status-badge">{CASE_STATUS_LABELS[caseData.status]}</div>
        </div>

        <div className="doc-title">SUPPLIER SERVICE REQUEST</div>

        {/* Row 1 — Case reference (no customer personal info) */}
        <table className="info-table">
          <tbody>
            <tr>
              <td className="lbl">ASSR NO</td>
              <td className="val bold">{caseData.caseNo}</td>
              <td className="lbl">Request Date</td>
              <td className="val">{fmt(caseData.complainedDate || caseData.createdAt)}</td>
              <td className="lbl">Category</td>
              <td className="val">{caseData.brand || ""}</td>
            </tr>
            <tr>
              <td className="lbl">Ref No</td>
              <td className="val">{caseData.refNo || ""}</td>
              <td className="lbl">PO No</td>
              <td className="val">{caseData.poNo || ""}</td>
              <td className="lbl">Service Category</td>
              <td className="val">{caseData.serviceCategory ? SERVICE_CATEGORY_LABELS[caseData.serviceCategory] : ""}</td>
            </tr>
          </tbody>
        </table>

        {/* Supplier Info */}
        <div className="section-label">Supplier Info</div>
        <table className="info-table">
          <tbody>
            <tr>
              <td className="lbl">Supplier Name</td>
              <td className="val" colSpan={3}>{caseData.supplierName || ""}</td>
              <td className="lbl">Service Status</td>
              <td className="val">{CASE_STATUS_LABELS[caseData.status]}</td>
            </tr>
          </tbody>
        </table>

        {/* Problem Description */}
        <div className="section-label">Problem Description</div>
        <div className="remark-box">{caseData.issueDescription}</div>

        {/* Item table */}
        <table className="item-table">
          <thead>
            <tr>
              <th style={{ width: 30 }}>NO</th>
              <th>ITEM</th>
              <th style={{ width: 40 }}>QTY</th>
              <th>REMARK (IF ANY)</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                <td className="center">{i + 1}</td>
                <td>{item.name}</td>
                <td className="center">{item.qty}</td>
                <td>{item.remark}</td>
              </tr>
            ))}
            {Array.from({ length: Math.max(0, 5 - items.length) }).map((_, i) => (
              <tr key={`empty-${i}`}>
                <td className="center">{items.length + i + 1}</td>
                <td></td>
                <td></td>
                <td></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Service Issue photos + Operation QC */}
        <div className="two-col">
          <div className="col">
            <div className="section-label">Service Issue (Attach Reference Picture)</div>
            <div className="photo-box">
              {caseData.photoUrls.length > 0 ? (
                <div className="photo-grid">
                  {caseData.photoUrls.map((url, i) => (
                    url.startsWith("data:video") ? (
                      <div key={i} className="photo-thumb" style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "#eee", fontSize: 9, color: "#666" }}>Video {i+1}</div>
                    ) : (
                      <img key={i} src={url} alt={`Issue ${i+1}`} className="photo-thumb" />
                    )
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="col">
            <div className="section-label">Operation QC Checked (Attach Reference Picture)</div>
            <div className="photo-box"></div>
          </div>
        </div>

        {/* Supplier Pickup / Ready */}
        <div className="section-label">Proof of Service</div>
        <table className="info-table">
          <tbody>
            <tr>
              <td className="lbl">Supplier Pickup Date</td>
              <td className="val"></td>
              <td className="lbl">Supplier Ready Date</td>
              <td className="val"></td>
            </tr>
            <tr>
              <td className="lbl">Proof of Pickup Date</td>
              <td className="val sig-cell">WH signature</td>
              <td className="lbl">Proof of Return Date</td>
              <td className="val sig-cell">WH signature</td>
            </tr>
          </tbody>
        </table>

        {/* Warehouse Acknowledgement */}
        <div className="two-col" style={{ marginTop: 8 }}>
          <div className="col">
            <div className="section-label">Supplier Remarks</div>
            <div className="remark-box tall">{caseData.supplierServiceNote || ""}</div>
          </div>
          <div className="col">
            <div className="section-label">Warehouse Acknowledgement</div>
            <div className="sig-box">
              <div>Warehouse Verified &amp; Acknowledged:</div>
              <div className="sig-line">Name :</div>
              <div className="sig-line">Date Received :</div>
            </div>
          </div>
        </div>

        {/* Call Logs (Purchasing ↔ Supplier communication) */}
        {caseData.callLogs && caseData.callLogs.length > 0 && (
          <>
            <div className="section-label">Purchasing Communication Log</div>
            <table className="item-table">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>DATE</th>
                  <th>DETAILS</th>
                </tr>
              </thead>
              <tbody>
                {caseData.callLogs.map((log, i) => (
                  <tr key={log.id}>
                    <td className="center">{log.date}</td>
                    <td>{log.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {/* Print button (hidden on print) */}
        <div className="no-print" style={{ marginTop: 16, textAlign: "center" }}>
          <button onClick={() => window.print()} className="print-btn">Print Supplier Template</button>
          <button onClick={() => window.history.back()} className="back-btn">Back</button>
        </div>
      </div>
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseItems(c: ASSRCase) {
  const items: { name: string; qty: string; remark: string }[] = [];
  if (c.itemDetails) {
    items.push({ name: `${c.productName}${c.productSku ? ` (${c.productSku})` : ""}`, qty: "1", remark: c.itemDetails });
  } else if (c.productName) {
    items.push({ name: c.productName, qty: "1", remark: "" });
  }
  return items;
}

// ─── Print Styles ───────────────────────────────────────────────────────────

const printStyles = `
  @media print {
    body { margin: 0; padding: 0; }
    .no-print { display: none !important; }
    @page { size: A4; margin: 10mm; }
  }
  .print-page {
    max-width: 210mm;
    margin: 0 auto;
    padding: 16px;
    font-family: Arial, sans-serif;
    font-size: 11px;
    color: #222;
    line-height: 1.4;
  }
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 4px;
  }
  .company-name { font-size: 14px; font-weight: 700; }
  .company-reg { font-size: 9px; color: #555; }
  .company-addr { font-size: 9px; color: #555; margin-top: 1px; }
  .status-badge {
    background: #0F766E;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .doc-title {
    text-align: center;
    font-size: 13px;
    font-weight: 700;
    border-top: 2px solid #222;
    border-bottom: 1px solid #ccc;
    padding: 4px 0;
    margin: 6px 0;
    letter-spacing: 1px;
  }
  .section-label {
    font-size: 10px;
    font-weight: 700;
    background: #f0f0f0;
    padding: 3px 6px;
    margin: 6px 0 2px;
    border-left: 3px solid #0F766E;
  }
  .info-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 4px;
  }
  .info-table td {
    border: 1px solid #ccc;
    padding: 3px 6px;
    font-size: 10px;
    vertical-align: top;
  }
  .info-table .lbl {
    background: #fafafa;
    font-weight: 600;
    color: #444;
    width: 16%;
    white-space: nowrap;
  }
  .info-table .val { width: 17%; }
  .info-table .bold { font-weight: 700; }
  .info-table .sig-cell { color: #999; font-style: italic; min-height: 30px; }
  .item-table {
    width: 100%;
    border-collapse: collapse;
    margin: 4px 0;
  }
  .item-table th {
    background: #0F766E;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    padding: 4px 6px;
    text-align: left;
    border: 1px solid #0F766E;
  }
  .item-table td {
    border: 1px solid #ccc;
    padding: 3px 6px;
    font-size: 10px;
    min-height: 20px;
  }
  .item-table .center { text-align: center; }
  .two-col { display: flex; gap: 8px; }
  .two-col .col { flex: 1; }
  .photo-box {
    border: 1px solid #ccc;
    min-height: 80px;
    background: #fafafa;
    padding: 4px;
  }
  .photo-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .photo-thumb {
    width: 72px;
    height: 72px;
    object-fit: cover;
    border: 1px solid #ddd;
    border-radius: 2px;
  }
  .sig-box {
    border: 1px solid #ccc;
    padding: 8px;
    font-size: 10px;
    min-height: 60px;
  }
  .sig-line { margin: 4px 0; }
  .remark-box {
    border: 1px solid #ccc;
    min-height: 30px;
    padding: 4px 6px;
    font-size: 10px;
  }
  .remark-box.tall { min-height: 60px; }
  .print-btn {
    background: #0F766E;
    color: #fff;
    border: none;
    padding: 8px 24px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
  }
  .print-btn:hover { background: #0c5f59; }
  .back-btn {
    background: #fff;
    color: #555;
    border: 1px solid #ccc;
    padding: 8px 24px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .back-btn:hover { background: #f5f5f5; }
`;
