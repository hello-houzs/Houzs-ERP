// Notion-style searchable combo:
//   - click to open
//   - type to filter
//   - click existing option to select
//   - if search has no exact match and `onCreate` is provided,
//     show "+ Create «query»" as the last row

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";

interface ComboProps {
  value: string;
  options: string[];
  onChange: (next: string) => void;
  onCreate?: (next: string) => void;
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
}

const inputClass =
  "w-full h-9 rounded-md border border-[#DDE5E5] px-2.5 text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]";

export function Combo({
  value,
  options,
  onChange,
  onCreate,
  placeholder = "Select…",
  allowClear = true,
  disabled,
}: ComboProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const q = query.trim().toUpperCase();
  const filtered = q ? options.filter((o) => o.toUpperCase().includes(q)) : options;
  const exactMatch = q && options.some((o) => o.toUpperCase() === q);
  const showCreate = onCreate && q && !exactMatch;

  function pick(opt: string) {
    onChange(opt);
    setOpen(false);
    setQuery("");
  }

  function create() {
    if (!onCreate) return;
    const next = query.trim();
    if (!next) return;
    onCreate(next);
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`${inputClass} flex items-center justify-between text-left ${
          disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"
        }`}
      >
        <span className={`truncate ${value ? "text-[#0A1F2E]" : "text-gray-400"}`}>
          {value || placeholder}
        </span>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {allowClear && value && !disabled && (
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
              className="h-5 w-5 rounded hover:bg-gray-100 inline-flex items-center justify-center text-gray-400 hover:text-gray-600"
              title="Clear"
            >
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        </div>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-[#DDE5E5] bg-white shadow-lg overflow-hidden">
          <div className="p-1.5 border-b border-[#F0F3F3]">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered.length > 0) pick(filtered[0]);
                  else if (showCreate) create();
                } else if (e.key === "Escape") {
                  setOpen(false);
                  setQuery("");
                }
              }}
              placeholder="Search…"
              className="w-full h-7 rounded px-2 text-[11px] bg-[#F4F7F7] focus:outline-none focus:ring-1 focus:ring-[#0F766E]/30"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && !showCreate && (
              <div className="px-3 py-2 text-[11px] text-gray-400">No matches</div>
            )}
            {filtered.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => pick(opt)}
                className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] text-[#0A1F2E] hover:bg-[#F4F7F7] text-left"
              >
                <span className="truncate">{opt}</span>
                {value === opt && <Check className="h-3 w-3 text-[#0F766E] shrink-0" />}
              </button>
            ))}
            {showCreate && (
              <button
                type="button"
                onClick={create}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-[#0F766E] hover:bg-[#0F766E]/10 border-t border-[#F0F3F3] text-left"
              >
                <Plus className="h-3 w-3" /> Create &ldquo;{query.trim()}&rdquo;
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
