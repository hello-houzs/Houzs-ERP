import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "brass";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  // Primary — Nature Black slab with brass right-edge underline on hover.
  primary:
    "bg-ink text-bg hover:bg-[#1a221a] border border-ink shadow-stone disabled:bg-ink/40 disabled:border-ink/40",
  // Brass — used for the highest-priority actions (Sync, etc.).
  brass:
    "bg-accent text-white hover:bg-accent-hover border border-accent shadow-brass disabled:bg-accent/40 disabled:border-accent/40",
  secondary:
    "bg-surface border border-border text-ink hover:bg-surface-dim hover:border-border-strong disabled:opacity-50",
  ghost: "bg-transparent text-ink-secondary hover:text-ink hover:bg-surface-dim",
  danger:
    "bg-surface border border-err/40 text-err hover:bg-err/5 hover:border-err disabled:opacity-50",
};

export function Button({ variant = "primary", icon, className, children, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-[13px] font-semibold tracking-wide transition-all duration-150",
        VARIANTS[variant],
        className
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode }) {
  return (
    <button
      {...rest}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent",
        className
      )}
    >
      {icon}
    </button>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-9 w-72 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
    />
  );
}
