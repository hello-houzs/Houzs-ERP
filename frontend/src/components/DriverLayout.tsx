import { type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Truck, User, LogOut } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/utils";

/**
 * Mobile-first shell for the driver app. Distinct from the dispatcher
 * Layout — no sidebar, sticky top brand bar, fixed bottom nav. Drivers
 * with only `trips.read.own` are auto-redirected here from App.tsx.
 */
export function DriverLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      {/* Top brand bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm">
        <img
          src="/logo-mark.png"
          alt="Houzs"
          className="h-8 w-8 object-contain"
          draggable={false}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            HC Delivery
          </div>
          <div className="truncate text-[13px] font-bold text-ink">
            {user?.name || user?.email || "Driver"}
          </div>
        </div>
        <button
          onClick={() => logout()}
          aria-label="Sign out"
          className="rounded-md border border-border px-2.5 py-1.5 text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
        >
          <LogOut size={15} />
        </button>
      </header>

      {/* Page body — pad bottom for the fixed bottom nav */}
      <main className="thin-scroll flex-1 overflow-y-auto pb-20">{children}</main>

      {/* Bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-2 border-t border-border bg-surface/95 backdrop-blur-sm">
        <BottomTab to="/driver" icon={<Truck size={18} />} label="Today" exact />
        <BottomTab to="/driver/me" icon={<User size={18} />} label="Profile" />
      </nav>
    </div>
  );
}

function BottomTab({
  to,
  icon,
  label,
  exact,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  exact?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={exact}
      className={({ isActive }) =>
        cn(
          "flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold uppercase tracking-wide transition-colors",
          isActive ? "text-accent" : "text-ink-secondary hover:text-ink"
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
