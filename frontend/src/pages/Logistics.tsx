import { useSearchParams } from "react-router-dom";
import { Route as RouteIcon, Users, Wrench } from "lucide-react";
import { cn } from "../lib/utils";
import { useAuth } from "../auth/AuthContext";
import { Trips } from "./Trips";
import { Fleet } from "./Fleet";
import { ServiceLogistics } from "./ServiceLogistics";

/**
 * Logistics shell — a single sidebar entry that hosts the Trips and
 * Fleet modules as primary tabs. Each child keeps its own sub-tab
 * strip and PageHeader; this wrapper only decides which one to mount
 * based on `?tab=` (or defaults to whichever the user has permission
 * for).
 *
 * Deep links from Inbox / global search use `/logistics?tab=trips&focus=…`
 * (or the legacy `/trips?focus=…` / `/fleet?focus=…` redirects in
 * App.tsx, which carry the rest of the query string through).
 */

type LogisticsTab = "trips" | "fleet" | "service";

export function Logistics() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();

  const canTrips = can("trips.read.all");
  const canFleet = can("fleet.read");
  // Service tab uses the same permission as the ASSR module — anyone
  // who can read service cases can see their pickups + deliveries here.
  const canService = can("service_cases.read");

  const visibleCount = [canTrips, canFleet, canService].filter(Boolean).length;
  const onlyOne = visibleCount === 1;

  const raw = params.get("tab") as LogisticsTab | null;
  const active: LogisticsTab =
    raw && ["trips", "fleet", "service"].includes(raw)
      ? raw
      : canTrips
      ? "trips"
      : canFleet
      ? "fleet"
      : "service";

  function setTab(next: LogisticsTab) {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    // Don't carry focus/sub params across the switch — they belong to
    // the side we're leaving.
    p.delete("focus");
    p.delete("sub");
    setParams(p, { replace: true });
  }

  const tabs: Array<{ value: LogisticsTab; label: string; icon: typeof RouteIcon; show: boolean }> = [
    { value: "trips", label: "Trips", icon: RouteIcon, show: canTrips },
    { value: "fleet", label: "Fleet", icon: Users, show: canFleet },
    { value: "service", label: "Service", icon: Wrench, show: canService },
  ];
  const visibleTabs = tabs.filter((t) => t.show);

  return (
    <div>
      {!onlyOne && visibleTabs.length > 1 && (
        <div className="mb-6 border-b border-border">
          <div className="mask-fade-r no-scrollbar -mx-4 flex items-center gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0 [&>*]:shrink-0">
            {visibleTabs.map((t) => {
              const Icon = t.icon;
              const isActive = t.value === active;
              return (
                <button
                  key={t.value}
                  onClick={() => setTab(t.value)}
                  className={cn(
                    "relative -mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-[12px] font-semibold transition-colors",
                    isActive
                      ? "border-accent text-accent"
                      : "border-transparent text-ink-secondary hover:text-ink"
                  )}
                >
                  <Icon size={14} strokeWidth={2.2} />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {active === "trips" && canTrips && <Trips />}
      {active === "fleet" && canFleet && <Fleet />}
      {active === "service" && canService && <ServiceLogistics />}
    </div>
  );
}
