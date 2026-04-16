"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Car, Truck, Phone } from "lucide-react";
import { useMasterData } from "@/lib/master-data-store";
import { useAllEvents } from "@/lib/events-store";

export default function DriverPage() {
  const router = useRouter();
  const master = useMasterData();
  const allEvents = useAllEvents();

  // Build per-driver assignment summary from events
  const driverLoad = useMemo(() => {
    const map: Record<string, { count: number; next?: string }> = {};
    for (const e of allEvents) {
      if (!e.setupDriver) continue;
      const slot = map[e.setupDriver] ?? { count: 0, next: undefined };
      slot.count += 1;
      if (!slot.next || e.startDate < slot.next) slot.next = e.startDate;
      map[e.setupDriver] = slot;
    }
    return map;
  }, [allEvents]);

  const upcoming = useMemo(
    () =>
      allEvents
        .filter((e) => e.setupDriver || e.setupLori)
        .sort((a, b) => a.startDate.localeCompare(b.startDate))
        .slice(0, 12),
    [allEvents]
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[#0A1F2E]">Driver</h1>
        <p className="text-sm text-gray-500 mt-1 inline-flex items-center gap-1.5">
          <Car className="h-3.5 w-3.5" />
          Driver roster, lori plates &amp; setup / dismantle assignments
        </p>
      </div>

      {/* Drivers */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Drivers</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">Manage names &amp; phones in Master Data</p>
          </div>
          <span className="text-[10px] font-semibold text-[#0F766E] bg-[#0F766E]/10 rounded px-2 py-0.5">
            {master.drivers.length} driver{master.drivers.length === 1 ? "" : "s"}
          </span>
        </div>
        {master.drivers.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-gray-400">
            No drivers yet — add them in <Link href="/settings" className="text-[#0F766E] font-semibold hover:underline">Master Data</Link>
          </div>
        ) : (
          <div className="divide-y divide-[#F0F3F3]">
            {master.drivers.map((d) => {
              const load = driverLoad[d.name];
              return (
                <div key={d.name} className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-[#FAFBFB]">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-semibold text-[#0A1F2E]">{d.name}</div>
                    <div className="text-[10px] text-gray-500 inline-flex items-center gap-1 tabular-nums">
                      <Phone className="h-2.5 w-2.5" />
                      {d.phone || "—"}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[11px] font-semibold text-[#0A1F2E] tabular-nums">
                      {load?.count ?? 0} job{(load?.count ?? 0) === 1 ? "" : "s"}
                    </div>
                    <div className="text-[9px] text-gray-400 tabular-nums">
                      next: {load?.next ?? "—"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Lori */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Lori (Trucks)</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">Fleet plates used for setup / dismantle</p>
          </div>
          <span className="text-[10px] font-semibold text-[#0F766E] bg-[#0F766E]/10 rounded px-2 py-0.5">
            {master.lori.length} truck{master.lori.length === 1 ? "" : "s"}
          </span>
        </div>
        {master.lori.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-gray-400">
            No lori yet — add them in <Link href="/settings" className="text-[#0F766E] font-semibold hover:underline">Master Data</Link>
          </div>
        ) : (
          <div className="p-3 flex flex-wrap gap-2">
            {master.lori.map((plate) => (
              <span
                key={plate}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#DDE5E5] bg-[#F4F7F7] px-2.5 py-1 text-[11px] font-semibold text-[#0A1F2E] tabular-nums"
              >
                <Truck className="h-3 w-3 text-[#0F766E]" />
                {plate}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Upcoming assignments */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Upcoming Assignments</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">Next events with driver / lori scheduled</p>
        </div>
        {upcoming.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-gray-400">
            No upcoming driver assignments yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-[12px]">
              <thead className="bg-[#F4F7F7] text-[9px] font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">Start</th>
                  <th className="text-left px-3 py-2">Event</th>
                  <th className="text-left px-3 py-2">Driver</th>
                  <th className="text-left px-3 py-2">Lori</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0F3F3]">
                {upcoming.map((e) => (
                  <tr
                    key={e.a42}
                    onDoubleClick={() => router.push(`/events/${encodeURIComponent(e.a42)}`)}
                    className="hover:bg-[#F4F7F7] cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-2 tabular-nums text-gray-600">{e.startDate}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/events/${encodeURIComponent(e.a42)}`}
                        className="text-[#0A1F2E] font-semibold hover:text-[#0F766E] truncate"
                      >
                        [{e.brand}] {e.venue}
                      </Link>
                      <div className="text-[9px] text-gray-400 uppercase tracking-wider">{e.state}</div>
                    </td>
                    <td className="px-3 py-2 font-semibold text-[#0A1F2E]">{e.setupDriver || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 tabular-nums">{e.setupLori || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2">
                      {e.setupDismantleStatus ? (
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                          e.setupDismantleStatus === "DISMANTLE DONE" ? "bg-emerald-100 text-emerald-700" :
                          e.setupDismantleStatus === "SETUP DONE"     ? "bg-sky-100 text-sky-700" :
                          e.setupDismantleStatus === "PREPARED"       ? "bg-amber-100 text-amber-700" :
                                                                         "bg-gray-100 text-gray-500"
                        }`}>{e.setupDismantleStatus}</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
