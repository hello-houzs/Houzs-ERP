import { useRef, useState } from 'react';
import { Check, Loader2, Upload, X } from 'lucide-react';
import {
  ALLOWED_SLIP_MIMES, MAX_SLIP_SIZE_BYTES,
  uploadSlipFull, type SlipUploadPhase,
} from '../lib/slip';
import paymentsStyles from '../../../pages/scm-v2/Payments.module.css';

const IMAGE_SLIP_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
  onImageScan,
}: {
  /** When true, the trigger label reads "Slip *" to signal the SAVED-mode
   *  requirement. DRAFT-mode callers leave it false (slip optional). */
  required?: boolean;
  disabled?: boolean;
  onConfirmed: (uploadSessionId: string) => void;
  onCleared: () => void;
  /** Optional. When an IMAGE (jpg/png/webp) is uploaded, the same file is also
   *  handed here so the caller can OCR-scan it (card-terminal / EPP receipt)
   *  and fill-blanks the payment row. Returns a promise that resolves when the
   *  scan settles — while it is pending the upload button shows a spinner in
   *  place of its icon (no extra element). PDFs are NOT passed (skipped). */
  onImageScan?: (file: File) => Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setPhase('idle'); setErrorMsg(null); setFileName(null); setScanning(false);
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

    /* Receipt OCR — fire IN PARALLEL with the slip upload when the file is an
       image (the receipt IS the slip). The scan never blocks or fails the
       upload; the caller reports its own outcome via a toast. The only UI
       effect here is the spinner-in-place-of-icon while it's pending. */
    if (onImageScan && IMAGE_SLIP_MIMES.has(f.type)) {
      setScanning(true);
      void onImageScan(f).finally(() => setScanning(false));
    }

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
          {/* Icon swaps to a same-size spinner while uploading OR OCR-scanning
              the receipt — no extra element, so the narrow Slip column never
              shifts. The button label is unchanged. */}
          {busy || scanning
            ? <Loader2 size={14} strokeWidth={1.75} className={paymentsStyles.slipScanSpin} />
            : <Upload size={14} strokeWidth={1.75} />}
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
