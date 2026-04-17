import { useState, useRef, useEffect } from "react";
import { X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[] | string[];
  placeholder?: string;
  className?: string;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select...",
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const filtered = search
    ? options.filter((o) => o.toUpperCase().includes(search.toUpperCase()))
    : options;

  return (
    <div className="relative" ref={ref}>
      {/* Display field */}
      <div
        className={cn(
          "w-full h-9 rounded-md border border-[#DDE5E5] bg-white flex items-center cursor-pointer",
          "hover:border-[#0F766E] focus-within:ring-2 focus-within:ring-[#0F766E]/30 focus-within:border-[#0F766E]",
          className,
        )}
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <span className={cn("flex-1 px-2.5 text-[12px] truncate", value ? "text-[#0A1F2E]" : "text-gray-400")}>
          {value || placeholder}
        </span>
        <div className="flex items-center gap-0.5 pr-1.5 shrink-0">
          {value && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onChange(""); }}
              className="h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50"
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        </div>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-white rounded-md border border-[#DDE5E5] shadow-lg overflow-hidden">
          <div className="p-1.5">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full h-7 rounded border border-[#DDE5E5] px-2 text-[11px] bg-[#FAFBFB] focus:outline-none focus:ring-1 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
            />
          </div>
          <div className="max-h-[180px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-gray-400 text-center">No results</div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    onChange(opt);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-[11px] hover:bg-[#F4F7F7] transition-colors",
                    opt === value ? "bg-[#0F766E]/10 text-[#0F766E] font-semibold" : "text-[#0A1F2E]",
                  )}
                >
                  {opt}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
