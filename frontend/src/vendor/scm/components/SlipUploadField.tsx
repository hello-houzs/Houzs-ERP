import { useRef, useState } from 'react';
import { Check, Upload, X } from 'lucide-react';
import {
  ALLOWED_SLIP_MIMES, MAX_SLIP_SIZE_BYTES,
  uploadSlipFull, type SlipUploadPhase,
} from '../lib/slip';
import paymentsStyles from '../../../pages/scm-v2/Payments.module.css';

type Phase = 'idle' | SlipUploadPhase | 'done' | 'error';

/* Spec D4 (2026-06-06) — per-payment slip uploader for PaymentsTable draft
   rows. Backend twin of the POS SlipUploadStep (file input only, no camera).
   Reuses the Payments table's addBtn / trashBtn classes so it sits flush with
   the inline-edited row controls. */
export function SlipUploadField({
  required = false,
  disabled = false,
  onConfirmed,
  onCleared,
}: {
  /** When true, the trigger label reads "Slip *" to signal the SAVED-mode
   *  requirement. DRAFT-mode callers leave it false (slip optional). */
  required?: boolean;
  disabled?: boolean;
  onConfirmed: (uploadSessionId: string) => void;
  onCleared: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setPhase('idle'); setErrorMsg(null); setFileName(null);
    if (inputRef.current) inputRef.current.value = '';
    onCleared();
  };

  const handleFile = async (f: File | null) => {
    if (!f) { reset(); return; }
    if (!(ALLOWED_SLIP_MIMES as readonly string[]).includes(f.type)) {
      setErrorMsg('Only JPG / PNG / WebP / PDF supported.'); setPhase('error'); return;
    }
    if (f.size > MAX_SLIP_SIZE_BYTES) {
      setErrorMsg('File too large (max 5 MB).'); setPhase('error'); return;
    }
    setFileName(f.name); setErrorMsg(null);
    try {
      const result = await uploadSlipFull({ file: f, onProgress: (p) => setPhase(p) });
      setPhase('done');
      onConfirmed(result.uploadSessionId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Upload failed.');
      setPhase('error'); onCleared();
    }
  };

  const busy = phase === 'init' || phase === 'put' || phase === 'confirm';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
      />
      {phase !== 'done' ? (
        <button
          type="button"
          className={paymentsStyles.addBtn}
          style={{ margin: 0, height: 24, padding: '0 8px', fontSize: 'var(--fs-11)' }}
          onClick={() => inputRef.current?.click()}
          disabled={busy || disabled}
        >
          <Upload size={14} strokeWidth={1.75} />
          {busy ? 'Uploading…' : (required ? 'Slip *' : 'Slip')}
        </button>
      ) : (
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 'var(--fs-11)', color: 'var(--c-secondary-a, #2F5D4F)', fontWeight: 600,
          }}
          title={fileName ?? undefined}
        >
          <Check size={14} strokeWidth={2} />
          {fileName && fileName.length > 14 ? `${fileName.slice(0, 12)}…` : fileName}
          <button
            type="button"
            className={paymentsStyles.trashBtn}
            onClick={reset}
            title="Remove slip"
            disabled={disabled}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      )}
      {errorMsg && (
        <span style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-11)' }}>
          {errorMsg}
        </span>
      )}
    </span>
  );
}
