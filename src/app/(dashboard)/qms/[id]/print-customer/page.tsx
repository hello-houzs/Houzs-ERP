"use client";
import { useMemo } from "react";
import { useParams } from "next/navigation";
import {
  useASSRCases,
  CASE_STATUS_LABELS, SERVICE_CATEGORY_LABELS,
  type ASSRCase,
} from "@/lib/assr-store";

// ─── Print-friendly Customer Pickup / Service Template ──────────────────────
// Shows: company header, case info, customer info, items, service issue area,
//        warehouse acknowledgement, proof of delivery, pickup/delivery signatures
// Hides: supplier info, internal notes, call logs, pricing

function fmt(d?: string) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "/");
}

export default function PrintCustomerPage() {
  const params = useParams<{ id: string }>();
  const caseId = decodeURIComponent(params.id);
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

        <div className="doc-title">AFTER-SALES SERVICE REQUEST</div>

        {/* Row 1 — Case reference */}
        <table className="info-table">
          <tbody>
            <tr>
              <td className="lbl">Sales Agent</td>
              <td className="val">{caseData.salesPerson || ""}</td>
              <td className="lbl">Request Date</td>
              <td className="val">{fmt(caseData.complainedDate || caseData.createdAt)}</td>
              <td className="lbl">ASSR NO</td>
              <td className="val bold">{caseData.caseNo}</td>
            </tr>
            <tr>
              <td className="lbl">Category</td>
              <td className="val">{caseData.brand || ""}</td>
              <td className="lbl">Delivery Return No</td>
              <td className="val">{caseData.goodsReturnedNote || "NA"}</td>
              <td className="lbl">Purchase Return No</td>
              <td className="val">NA</td>
            </tr>
          </tbody>
        </table>

        {/* Customer Info */}
        <div className="section-label">Customer Info</div>
        <table className="info-table">
          <tbody>
            <tr>
              <td className="lbl">Customer Name</td>
              <td className="val">{caseData.customerName}</td>
              <td className="lbl">HP</td>
              <td className="val">{caseData.customerPhone}</td>
              <td className="lbl">Ref No</td>
              <td className="val">{caseData.refNo || ""}</td>
            </tr>
            <tr>
              <td className="lbl">Delivered Date</td>
              <td className="val">{fmt(caseData.doDeliveredDate)}</td>
              <td className="lbl">PO No</td>
              <td className="val">{caseData.poNo || ""}</td>
              <td className="lbl">New PO No</td>
              <td className="val"></td>
            </tr>
            <tr>
              <td className="lbl">Address</td>
              <td className="val" colSpan={5}>{[caseData.address1, caseData.address2, caseData.address3, caseData.address4].filter(Boolean).join(", ")}</td>
            </tr>
            <tr>
              <td className="lbl">Description of the problem</td>
              <td className="val" colSpan={5}>{caseData.issueDescription}</td>
            </tr>
          </tbody>
        </table>

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

        {/* Service Issue + Warehouse Acknowledgement */}
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
            <div className="section-label">Warehouse Acknowledgement</div>
            <div className="sig-box">
              <div>Warehouse Received &amp; Signed:</div>
              <div className="sig-line">Name :</div>
              <div className="sig-line">Date Received :</div>
              <div style={{ marginTop: 8, fontSize: 9 }}>Warehouse Contact<br/>Houzs: CS Team | 011-6155 6133</div>
            </div>
          </div>
        </div>

        {/* Proof of Delivery */}
        <div className="section-label">Proof of Delivery</div>
        <table className="info-table">
          <tbody>
            <tr>
              <td className="lbl">Ship Via</td>
              <td className="val"></td>
              <td className="lbl">DO number</td>
              <td className="val">{caseData.deliveryOrderNo || ""}</td>
              <td className="lbl">Delivery Status</td>
              <td className="val"></td>
            </tr>
            <tr>
              <td className="lbl">Service Pickup<br/>(Customer) Date</td>
              <td className="val"></td>
              <td className="lbl">Service Delivery<br/>(Customer) Date</td>
              <td className="val"></td>
              <td></td>
              <td></td>
            </tr>
          </tbody>
        </table>

        {/* Proof of Pickup / Service Delivery signatures */}
        <div className="two-col" style={{ marginTop: 8 }}>
          <div className="col">
            <div className="section-label">Proof of Pickup</div>
            <div className="sig-box tall">
              <div style={{ textAlign: "center", color: "#999", marginTop: 40 }}>customer signature</div>
              <div className="sig-footer">(Customer Signature)</div>
            </div>
          </div>
          <div className="col">
            <div className="section-label">Proof of Service Delivery</div>
            <div className="sig-box tall">
              <div style={{ textAlign: "center", color: "#999", marginTop: 40 }}>customer signature</div>
              <div className="sig-footer">(Customer Signature)</div>
            </div>
          </div>
        </div>

        {/* Logistic/Admin Remarks */}
        <div className="section-label">Logistic/Admin Remarks</div>
        <div className="remark-box">{caseData.actionRemark || ""}</div>

        {/* Print button (hidden on print) */}
        <div className="no-print" style={{ marginTop: 16, textAlign: "center" }}>
          <button onClick={() => window.print()} className="print-btn">Print Customer Template</button>
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
    width: 14%;
    white-space: nowrap;
  }
  .info-table .val { width: 19%; }
  .info-table .bold { font-weight: 700; }
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
  .sig-box.tall { min-height: 90px; position: relative; }
  .sig-footer {
    text-align: center;
    font-size: 9px;
    color: #666;
    margin-top: 20px;
    border-top: 1px solid #ccc;
    padding-top: 2px;
  }
  .sig-line { margin: 4px 0; }
  .remark-box {
    border: 1px solid #ccc;
    min-height: 30px;
    padding: 4px 6px;
    font-size: 10px;
  }
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
