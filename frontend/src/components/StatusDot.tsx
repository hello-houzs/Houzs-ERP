import { cn } from "../lib/utils";

type Variant = "synced" | "error" | "open" | "in-progress" | "closed" | "neutral";

const COLORS: Record<Variant, string> = {
  synced: "bg-synced",
  error: "bg-err",
  open: "bg-amber-500",
  "in-progress": "bg-accent",
  closed: "bg-synced",
  neutral: "bg-ink-muted",
};

interface Props {
  variant: Variant;
  label?: string;
  className?: string;
}

export function StatusDot({ variant, label, className }: Props) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("h-2 w-2 rounded-full", COLORS[variant])} />
      {label && <span className="text-xs text-ink-secondary">{label}</span>}
    </span>
  );
}

export function statusVariantForAssr(status: string): Variant {
  const s = status.toLowerCase();
  if (s.includes("closed") || s.includes("complete")) return "closed";
  if (s.includes("progress")) return "in-progress";
  if (s.includes("open") || s.includes("verification")) return "open";
  return "neutral";
}
