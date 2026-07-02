// MobileScan — OCR scan order slip -> background draft. Maps to prototype: #scan.
export function MobileScan({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: () => void }) {
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#767b6e', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        <div className="scr-title">Scan order slip</div>
        <div style={{ fontSize: 11, color: '#767b6e', marginTop: 2 }}>Snap the slip — we OCR it in the background into a draft SO.</div>
      </header>
      <div className="scroll">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
          <div style={{ aspectRatio: '3 / 4', borderRadius: 13, background: 'linear-gradient(135deg,#d7ded6,#c7d0c4)', position: 'relative' }}>
            <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#4a4f45', fontWeight: 700 }}>Page 1 &#10003;</span>
          </div>
          <button style={{ aspectRatio: '3 / 4', border: '1.5px dashed #16695f', borderRadius: 13, background: '#f4f6f3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, fontFamily: 'inherit', cursor: 'pointer' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: '#16695f' }}>Add page</span>
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, background: '#f3ece0', border: '1px solid #e8dcc5', borderRadius: 11, padding: 11, marginTop: 12, fontSize: 11, color: '#6a4a1e', lineHeight: 1.5 }}>
          Submit runs OCR in the background. You can scan the next slip immediately — each draft appears in Sales Orders when ready.
        </div>
      </div>
      <div className="actbar"><button className="btn" onClick={onSubmit}>Submit — process in background</button></div>
    </div>
  );
}
