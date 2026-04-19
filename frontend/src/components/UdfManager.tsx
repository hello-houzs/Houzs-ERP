import { useEffect, useState } from "react";
import { Plus, Trash2, Database } from "lucide-react";
import { Button } from "./Button";
import { Panel } from "./Panel";
import type { UseUdfResult, UdfFieldType } from "../hooks/useUdf";
import { useDialog } from "../hooks/useDialog";
import { useToast } from "../hooks/useToast";
import { cn } from "../lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The hook instance from `useUdf(table)`. */
  udf: UseUdfResult;
  /** Friendly name for the table being managed (e.g. "Sales Orders"). */
  tableLabel: string;
}

const FIELD_TYPES: Array<{ value: UdfFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select" },
  { value: "checkbox", label: "Checkbox" },
];

/**
 * Side-panel manager for user-defined fields on a single table.
 *
 * Renders inside <Panel/> (which portals to body and slides in from the
 * right). The Panel handles its own internal scroll, so this body can be
 * arbitrarily long without breaking layout — we no longer rely on a
 * centered modal that grows with the page underneath.
 *
 * UDFs are stored in worker D1 and never round-trip to AutoCount.
 */
export function UdfManager({ open, onClose, udf, tableLabel }: Props) {
  const dialog = useDialog();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [type, setType] = useState<UdfFieldType>("text");
  const [optionsRaw, setOptionsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Auto-derive snake_case key from the label as the user types
  useEffect(() => {
    if (!creating) return;
    const auto = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (auto && (key === "" || key === toAutoKey(label.slice(0, -1)))) {
      setKey(auto);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, creating]);

  function toAutoKey(s: string) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  }

  // Reset the create form whenever the panel closes.
  useEffect(() => {
    if (!open) {
      setCreating(false);
      setLabel("");
      setKey("");
      setType("text");
      setOptionsRaw("");
      setFormError(null);
    }
  }, [open]);

  async function submitNew() {
    setFormError(null);
    if (!label.trim()) {
      setFormError("Label is required");
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      setFormError("Key must be snake_case starting with a letter");
      return;
    }
    let options: string[] | undefined;
    if (type === "select") {
      options = optionsRaw
        .split(/\r?\n|,/)
        .map((o) => o.trim())
        .filter(Boolean);
      if (!options.length) {
        setFormError("Select fields need at least one option");
        return;
      }
    }
    setSubmitting(true);
    try {
      await udf.addField({ label: label.trim(), key, type, options });
      setLabel("");
      setKey("");
      setOptionsRaw("");
      setType("text");
      setCreating(false);
    } catch (e: any) {
      setFormError(e?.message || "Failed to add field");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(fieldKey: string, fieldLabel: string) {
    if (
      !await dialog.confirm(
        `Delete custom field "${fieldLabel}"?\n\nAll values stored across rows will be removed. This cannot be undone.`
      )
    )
      return;
    try {
      await udf.deleteField(fieldKey);
    } catch (e: any) {
      toast.error(`Failed to delete: ${e?.message || e}`);
    }
  }

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={tableLabel}
      subtitle="Custom Fields · Local-only, never synced to AutoCount"
      width={460}
    >
      {udf.loading && (
        <div className="py-6 text-center text-sm text-ink-muted">Loading…</div>
      )}
      {udf.error && (
        <div className="rounded border border-err/30 bg-err/5 px-3 py-2 text-xs text-err">
          {udf.error}
        </div>
      )}

      {!udf.loading && !udf.error && (
        <>
          {udf.fields.length === 0 && !creating && (
            <div className="rounded-md border border-dashed border-border bg-bg px-5 py-8 text-center">
              <Database size={24} className="mx-auto mb-2 text-ink-muted" />
              <div className="text-[13px] font-medium text-ink">No custom fields yet</div>
              <div className="mt-1 text-[11px] text-ink-muted">
                Add your first field below.
              </div>
            </div>
          )}

          {udf.fields.length > 0 && (
            <ul className="space-y-2">
              {udf.fields.map((f) => (
                <li
                  key={f.key}
                  className="group flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:border-accent/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink">{f.label}</span>
                      <span className="rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                        {f.type}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-ink-muted">
                      {f.key}
                      {f.options && ` · ${f.options.length} options`}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(f.key, f.label)}
                    className="rounded p-1.5 text-ink-muted opacity-0 transition-all hover:bg-err/10 hover:text-err group-hover:opacity-100"
                    aria-label={`Delete ${f.label}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Create form */}
          {creating ? (
            <div className="mt-5 rounded-md border border-accent/30 bg-accent-soft/30 p-4">
              <div className="mb-4 text-[10px] font-semibold uppercase tracking-brand text-accent">
                New Custom Field
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <FieldLabel>Label</FieldLabel>
                  <FieldInput
                    value={label}
                    onChange={(v) => setLabel(v)}
                    placeholder="e.g. Internal Notes"
                    autoFocus
                  />
                </div>
                <div>
                  <FieldLabel>Key</FieldLabel>
                  <FieldInput
                    value={key}
                    onChange={(v) => setKey(v.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                    placeholder="snake_case"
                    mono
                  />
                </div>
                <div>
                  <FieldLabel>Type</FieldLabel>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as UdfFieldType)}
                    className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                {type === "select" && (
                  <div className="col-span-2">
                    <FieldLabel>Options (comma or newline separated)</FieldLabel>
                    <textarea
                      value={optionsRaw}
                      onChange={(e) => setOptionsRaw(e.target.value)}
                      placeholder="High&#10;Medium&#10;Low"
                      className="min-h-[68px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                    />
                  </div>
                )}
              </div>
              {formError && <div className="mt-3 text-[11px] text-err">{formError}</div>}
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button variant="brass" onClick={submitNew} disabled={submitting}>
                  {submitting ? "Adding…" : "Add Field"}
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className={cn(
                "mt-4 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-transparent py-3 text-[12px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors",
                "hover:border-accent hover:bg-accent-soft/30 hover:text-accent"
              )}
            >
              <Plus size={14} />
              Add Custom Field
            </button>
          )}

          <div className="mt-6 border-t border-border-subtle pt-3 text-[10px] text-ink-muted">
            Stored in worker D1 · Never sent to AutoCount
          </div>
        </>
      )}
    </Panel>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      {children}
    </label>
  );
}

function FieldInput({
  value,
  onChange,
  placeholder,
  mono,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={cn(
        "h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20",
        mono && "font-mono text-[12px]"
      )}
    />
  );
}
