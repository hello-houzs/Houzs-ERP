import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { cn } from "../lib/utils";

type Status = "idle" | "saving" | "ok" | "error";

interface Props {
  label: string;
  value: string | number | null | undefined;
  type?: "text" | "date" | "number";
  onSave: (newValue: string | null) => Promise<void>;
  placeholder?: string;
  textarea?: boolean;
  /** When provided, renders a <select> dropdown instead of an input. */
  options?: readonly string[];
}

export function InlineEdit({ label, value, type = "text", onSave, placeholder, textarea, options }: Props) {
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);

  async function commit(next?: string) {
    const original = value == null ? "" : String(value);
    const nextVal = next ?? draft;
    if (nextVal === original) return;
    setStatus("saving");
    setError(null);
    try {
      await onSave(nextVal === "" ? null : nextVal);
      setStatus("ok");
      setTimeout(() => setStatus("idle"), 1500);
    } catch (e: any) {
      setStatus("error");
      setError(e?.message || "Failed");
    }
  }

  const inputClass = cn(
    "w-full rounded-md border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors",
    "focus:border-primary focus:ring-2 focus:ring-primary/20",
    status === "error" ? "border-err" : "border-border"
  );

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          {label}
        </label>
        {status === "saving" && (
          <span className="text-[9px] font-medium uppercase tracking-wider text-accent">
            saving…
          </span>
        )}
        {status === "ok" && <Check size={12} className="text-synced" />}
        {status === "error" && <X size={12} className="text-err" />}
      </div>
      {options ? (
        <select
          className={cn(inputClass, "appearance-none pr-8")}
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            commit(v);
          }}
        >
          <option value="">— none —</option>
          {/* Include the current value even if it isn't in the option list, so legacy/unknown values aren't silently overwritten. */}
          {draft && !options.includes(draft) && <option value={draft}>{draft}</option>}
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : textarea ? (
        <textarea
          className={cn(inputClass, "min-h-[68px] resize-y")}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
        />
      ) : (
        <input
          type={type}
          className={inputClass}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
        />
      )}
      {error && <div className="mt-1 text-[11px] text-err">{error}</div>}
    </div>
  );
}
