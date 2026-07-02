// MobileCalendar — month grid with brand/venue/organizer filters. Maps to prototype: #calendar.
import { useState } from 'react';

export interface CalEvent { day: number; status: 'Confirmed' | 'Pending' | 'Cancelled'; title: string; }
const BAR: Record<string, string> = { Confirmed: '#2f8a5b', Pending: '#cf9a2e', Cancelled: '#b23a3a' };

export function MobileCalendar({ month_label, events, onOpenMenu, onPrev, onNext }:
  { month_label: string; events: CalEvent[]; onOpenMenu: () => void; onPrev: () => void; onNext: () => void }) {
  const [mode, setMode] = useState<'Month' | 'Week'>('Month');
  const byDay: Record<number, CalEvent[]> = {};
  events.forEach((e) => { (byDay[e.day] = byDay[e.day] || []).push(e); });
  const days = Array.from({ length: 35 }, (_, i) => i - 2); // simple 5-week grid, offset demo
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={onPrev} className="iconbtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2"><path d="M15 6l-6 6 6 6" /></svg></button>
          <div className="scr-title" style={{ flex: 1, textAlign: 'center' }}>{month_label}</div>
          <button onClick={onNext} className="iconbtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2"><path d="M9 6l6 6-6 6" /></svg></button>
        </div>
        <div style={{ display: 'flex', background: '#f4f6f3', border: '1px solid #d6d9d2', borderRadius: 9, padding: 3, marginTop: 10 }}>
          {(['Month', 'Week'] as const).map((m) => <span key={m} onClick={() => setMode(m)} style={{ flex: 1, textAlign: 'center', fontSize: 11.5, fontWeight: 700, padding: '5px 0', borderRadius: 6, cursor: 'pointer', background: mode === m ? '#16695f' : 'transparent', color: mode === m ? '#fff' : '#767b6e' }}>{m}</span>)}
        </div>
        <div className="chips" style={{ marginTop: 9, display: 'flex', gap: 7 }}>
          <button className="chip on">All brands</button><button className="chip">Venue</button><button className="chip">Organizer</button>
          <button className="chip" style={{ marginLeft: 'auto' }} onClick={onOpenMenu}>Menu</button>
        </div>
      </header>
      <div className="scroll">
        <div style={{ display: 'flex', gap: 14, marginBottom: 8, fontSize: 10.5 }}>
          {Object.entries(BAR).map(([k, c]) => <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />{k}</span>)}
        </div>
        <div style={{ border: '1px solid #e3e6e0', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', background: '#f4f6f3', fontSize: 9, fontWeight: 700, color: '#9aa093', textAlign: 'center' }}>
            {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d) => <div key={d} style={{ padding: '6px 0' }}>{d}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' }}>
            {days.map((d, i) => {
              const evs = d >= 1 && d <= 31 ? (byDay[d] || []) : [];
              return (
                <div key={i} style={{ minHeight: 60, borderTop: '1px solid #eceee9', borderRight: (i % 7 !== 6) ? '1px solid #f0f1ed' : 'none', padding: 4 }}>
                  {d >= 1 && d <= 31 && <div style={{ fontSize: 10, fontWeight: 700, color: '#11140f' }}>{d}</div>}
                  {evs.slice(0, 2).map((e, j) => <div key={j} style={{ marginTop: 3, height: 5, borderRadius: 2, background: BAR[e.status] }} />)}
                  {evs.length > 2 && <div style={{ fontSize: 8, color: '#a16a2e', marginTop: 2 }}>+{evs.length - 2} more</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
