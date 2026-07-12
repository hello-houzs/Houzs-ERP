import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "brass";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  // Primary — petrol/teal fill (Theme C). The functional emphasis color,
  // same family as active tabs / selected rows / links, so every CTA in
  // the app reads as one. Brass is now brand-only (not a CTA fill).
  primary:
    "bg-primary text-white hover:bg-primary-ink border border-primary shadow-sm disabled:bg-primary/40 disabled:border-primary/40",
  // Brass — legacy alias kept for existing callers; now identical to
  // primary (brass CTAs were demoted to the brand-only accent).
  brass:
    "bg-primary text-white hover:bg-primary-ink border border-primary shadow-sm disabled:bg-primary/40 disabled:border-primary/40",
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

// IconButton — Plan B "Soft Card" (design handoff 2026-07-10): white card +
// hairline border; hover turns petrol, lifts 1px and casts a petrol glow;
// active settles back. Danger state stays the established pattern — callers
// pass err utility classes via className (no danger variant).
type IconButtonVariant = "ghost" | "primary" | "secondary";
type IconButtonSize = "sm" | "md" | "lg";

const ICON_BUTTON_SIZES: Record<IconButtonSize, string> = {
  sm: "h-[30px] w-[30px] rounded-lg [&>svg]:h-[15px] [&>svg]:w-[15px]",
  md: "h-9 w-9 rounded-[10px] [&>svg]:h-[18px] [&>svg]:w-[18px]",
  lg: "h-[42px] w-[42px] rounded-xl [&>svg]:h-5 [&>svg]:w-5",
};

const ICON_BUTTON_VARIANTS: Record<IconButtonVariant, string> = {
  ghost:
    "border-border bg-surface text-ink shadow-[0_1px_1px_rgba(17,20,15,0.04)] hover:border-primary hover:text-primary hover:shadow-[0_2px_8px_rgba(22,105,95,0.18)] active:shadow-[0_1px_1px_rgba(17,20,15,0.05)]",
  primary:
    "border-primary bg-primary text-white shadow-[0_1px_3px_rgba(22,105,95,0.35)] hover:border-primary-ink hover:bg-primary-ink hover:shadow-[0_3px_10px_rgba(22,105,95,0.3)]",
  secondary:
    "border-transparent bg-surface-2 text-ink-muted hover:border-primary hover:bg-primary hover:text-white hover:shadow-[0_2px_8px_rgba(22,105,95,0.18)]",
};

export function IconButton({
  icon,
  variant = "ghost",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
}) {
  return (
    <button
      {...rest}
      className={cn(
        "flex shrink-0 items-center justify-center border transition-all duration-[160ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px active:translate-y-0 disabled:pointer-events-none disabled:opacity-45 [&>svg]:stroke-[1.75]",
        ICON_BUTTON_SIZES[size],
        ICON_BUTTON_VARIANTS[variant],
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
      className="h-9 w-72 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
    />
  );
}
