import { useState } from 'react';
import { Badge } from './MobileSoList';

// MobileServiceCase — after-sales case detail (+ new). Maps to prototype: #service, #service-new.
// Detail: 9-stage pipeline (h-scroll), reported issue, product+PO, resolution, customer & PIC, SLA, timeline.
// New: SO lookup, product, issue category, priority, issue no, description, attachments.

export interface ServiceCase {
  case_no: string;
  stage: 'Pending pickup' | 'Item ready' | 'Delivery' | 'Completed';
  priority: 'Low' | 'Medium' | 'High';
  customer_name: string; phone: string;
  product_name: string; sku: string; so_doc_no: string;
  issue_description: string;
  resolution_method: string; supplier_name: string; supplier_pickup_date: string;
  pic_name: string; sla_label: string; sla_overdue?: boolean;
}
const STAGES = ['Logged', 'Pending pickup', 'Inspection', 'Resolution', 'QC', 'Completed'];

export function MobileServiceCase({ svc, onBack }: { svc: ServiceCase; onBack: () => void }) {
  const cur = STAGES.indexOf(svc.stage === 'Item ready' ? 'Resolution' : svc.stage === 'Delivery' ? 'QC' : svc.stage);
  const Row = ({ l, v, red }: { l: string; v: string; red?: boolean }) => <div className="row"><span className="row-l">{l}</span><span className="row-v money" style={red ? { color: '#b23a3a' } : undefined}>{v}</span></div>;
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>&lsaquo; Service Cases</button>
          <Badge status={svc.stage} />
        </div>
        <div className="eyebrow" style={{ marginTop: 7 }}>{svc.case_no} · {svc.priority}</div>
        <div className="scr-title">{svc.customer_name}</div>
      </header>
      <div className="scroll">
        <div className="card"><div className="card-b">
          <div className="fld-l" style={{ marginBottom: 8 }}>Workflow</div>
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
            {STAGES.map((s, i) => <span key={s} style={{ flex: 'none', fontSize: 10, fontWeight: 700, padding: '5px 9px', borderRadius: 20, background: i < cur ? '#e2f0e9' : i === cur ? '#f6efd9' : '#f4f6f3', color: i < cur ? '#2f8a5b' : i === cur ? '#8a6a2e' : '#9aa093' }}>{s}</span>)}
          </div>
        </div></div>
        <div style={{ background: '#fbf2f2', border: '1px solid #f0d9d9', borderRadius: 12, padding: '12px 13px', marginBottom: 11 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', color: '#b23a3a' }}>Reported issue</div>
          <div style={{ fontSize: 12.5, color: '#3f2626', marginTop: 5, lineHeight: 1.5 }}>{svc.issue_description}</div>
        </div>
        <div className="card"><div className="card-h"><span className="card-t">Product &amp; PO</span></div>
          <Row l="Product" v={svc.product_name} /><Row l="SKU" v={svc.sku} /><Row l="Origin SO" v={svc.so_doc_no} />
        </div>
        <div className="card"><div className="card-h"><span className="card-t">Resolution</span></div>
          <Row l="Method" v={svc.resolution_method} /><Row l="Supplier" v={svc.supplier_name} /><Row l="Pickup date" v={svc.supplier_pickup_date} />
        </div>
        <div className="card"><div className="card-h"><span className="card-t">Customer &amp; PIC</span></div>
          <Row l="Phone" v={svc.phone} /><Row l="PIC" v={svc.pic_name} /><Row l="SLA" v={svc.sla_label} red={svc.sla_overdue} />
        </div>
      </div>
      <div className="actbar">
        <button className="btn btn-ghost" style={{ flex: 1 }}>Print</button>
        <button className="btn" style={{ flex: 1.4 }}>Advance stage &rarr;</button>
      </div>
    </div>
  );
}

// New Service Case
export function MobileServiceCaseNew({ onCancel, onCreate }: { onCancel: () => void; onCreate: () => void }) {
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#767b6e', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        <div className="scr-title">New Service Case</div>
      </header>
      <div className="scroll">
        <div className="card"><div className="card-b">
          <div className="fld"><span className="fld-l">Customer / SO lookup *</span><input className="fld-i" placeholder="Search SO no or customer" /></div>
          <div className="fld"><span className="fld-l">Product *</span><input className="fld-i" placeholder="Auto-filled from SO line" /></div>
          <div style={{ display: 'flex', gap: 9 }}>
            <div style={{ flex: 1 }}><div className="fld"><span className="fld-l">Issue category *</span><input className="fld-i" defaultValue="Product defect" /></div></div>
            <div style={{ flex: 1 }}><div className="fld"><span className="fld-l">Priority *</span><input className="fld-i" defaultValue="Medium" /></div></div>
          </div>
          <div className="fld"><span className="fld-l">Issue number</span><input className="fld-i" placeholder="Customer complaint / ticket ref" /></div>
          <div className="fld"><span className="fld-l">Issue description *</span><textarea className="fld-i" rows={3} style={{ resize: 'none' }} placeholder="Describe the defect / fault" /></div>
        </div></div>
        <div className="card"><div className="card-h"><span className="card-t">Attachments</span><span className="card-sub">0 / 5</span></div><div className="card-b">
          <button style={{ width: '100%', border: '1px dashed #c2c6bd', borderRadius: 11, padding: 18, background: '#f4f6f3', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: '#16695f', cursor: 'pointer' }}>+ Add photo / video / PDF</button>
          <div style={{ fontSize: 10, color: '#9aa093', marginTop: 7, textAlign: 'center' }}>JPG / PNG / WEBP / MP4 / PDF · 5MB each · up to 5</div>
        </div></div>
      </div>
      <div className="actbar"><button className="btn" style={{ flex: 1 }} onClick={onCreate}>Create case</button></div>
    </div>
  );
}
