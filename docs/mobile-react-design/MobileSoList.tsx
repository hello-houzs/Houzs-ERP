import { SalesOrder, money } from './types';

// MobileSoList — Sales Orders list. Data: SalesOrder[] (subset of fields used below).
// Maps to prototype screen: #so-list.

const statusColor: Record<string, [string, string]> = {
  Draft: ['#f4f6f3', '#767b6e'], Submitted: ['#e1efed', '#0c3f39'],
  Confirmed: ['#e2f0e9', '#2f8a5b'], Cancelled: ['#f8eaea', '#b23a3a'],
};

export function Badge({ status }: { status: string }) {
  const c = statusColor[status] ?? ['#f4f6f3', '#767b6e'];
  return <span className="badge" style={{ background: c[0], color: c[1] }}>{status}</span>;
}

export interface MobileSoListProps {
  orders: SalesOrder[];
  onOpenMenu: () => void;
  onNew: () => void;
  onOpen: (doc_no: string) => void;
}

const MOCK: SalesOrder[] = [/* engineer: pass real orders; see types.ts */];

export function MobileSoList({ orders = MOCK, onOpenMenu, onNew, onOpen }: MobileSoListProps) {
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div><div className="eyebrow">Supply chain</div><div className="scr-title">Sales Orders</div></div>
          <button className="iconbtn" onClick={onNew} aria-label="New sales order">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
          <div className="searchbar" style={{ flex: 1 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input placeholder="Search doc no · customer" />
          </div>
          <button className="iconbtn" aria-label="Filter" onClick={onOpenMenu}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
          </button>
        </div>
      </header>
      <div className="scroll">
        {/* LIST START: sales_orders — one row per record */}
        {orders.map((r) => {
          const balance_centi = r.total_centi - r.paid_centi;
          return (
            <div key={r.doc_no} className="card" style={{ cursor: 'pointer', padding: '12px 13px' }} onClick={() => onOpen(r.doc_no)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: '#11140f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.customer_name}</span>
                <Badge status={r.status} />
              </div>
              <div className="money" style={{ fontSize: 11.5, color: '#767b6e', marginTop: 5 }}>{r.doc_no} · {r.customer_so_no}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11, color: '#414539' }}>
                <span style={{ color: '#9aa093', fontWeight: 600 }}>Processing</span><span className="money" style={{ fontWeight: 600 }}>{r.internal_expected_dd}</span>
                <span style={{ color: '#c2c6bd' }}>&rarr;</span>
                <span style={{ color: '#9aa093', fontWeight: 600 }}>Delivery</span><span className="money" style={{ fontWeight: 600 }}>{r.customer_delivery_date}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 9, paddingTop: 9, borderTop: '1px solid #f0f1ed' }}>
                <span style={{ fontSize: 10, color: '#9aa093' }}>Balance {money(balance_centi)}</span>
                <span className="money" style={{ fontSize: 14, fontWeight: 800, color: '#0c3f39' }}>{money(r.total_centi)}</span>
              </div>
            </div>
          );
        })}
        {/* LIST END */}
        {orders.length === 0 && (
          <div className="empty"><div className="empty-t">No sales orders</div><div className="empty-s">No orders in this range. Tap + to create one.</div></div>
        )}
      </div>
    </div>
  );
}
