import { useEffect, useRef } from "react";
import { AuthProvider, PresenceIndicator } from "autocount-sync-frontend";

// PresenceIndicator is CONNECTED via usePresence: once the auth user lands it
// POSTs /api/presence/heartbeat and GETs /api/presence on a 30s cadence, then
// renders the pulsing dot + avatar stack. It returns null until the first
// presence payload arrives, so both endpoints are stubbed below.

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const MEMBERS = [
  { id: 4, email: "farra@houzscentury.com", name: "Farra Aziz", role_id: 3, role_name: "Sales Executive", last_seen_at: new Date().toISOString(), is_self: true },
  { id: 7, email: "weijian@houzscentury.com", name: "Wei Jian", role_id: 5, role_name: "Logistics Coordinator", last_seen_at: new Date().toISOString(), is_self: false },
  { id: 11, email: "aina@houzscentury.com", name: "Aina Rahman", role_id: 6, role_name: "Service Admin", last_seen_at: new Date().toISOString(), is_self: false },
  { id: 9, email: "melissa@houzscentury.com", name: "Melissa Tan", role_id: 4, role_name: "Finance Manager", last_seen_at: new Date().toISOString(), is_self: false },
  { id: 1, email: "hello@houzscentury.com", name: "Nick Ho", role_id: 1, role_name: "Managing Director", last_seen_at: new Date().toISOString(), is_self: false },
];

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/auth/status")) return json({ has_users: true });
  if (url.includes("/api/auth/me"))
    return json({
      user: {
        id: 4,
        email: "farra@houzscentury.com",
        name: "Farra Aziz",
        role_id: 3,
        role_name: "Sales Executive",
        status: "active",
        permissions: ["scm.access", "service_cases.read"],
        page_access: {},
        profile_pic_r2_key: null,
        scm_l2_configured: false,
      },
    });
  if (url.includes("/api/presence/heartbeat")) return json({ ok: true });
  if (url.includes("/api/presence"))
    return json({ active: MEMBERS, count: MEMBERS.length, window_seconds: 120 });
  return realFetch(input as RequestInfo, init);
};

/** Closed pill — pulsing dot, 3-avatar stack, +2 overflow, "5 online". */
export const Pill = () => (
  <AuthProvider>
    <div className="flex h-16 w-72 items-center justify-end bg-surface px-4">
      <PresenceIndicator />
    </div>
  </AuthProvider>
);

/** Popover open — mount-time click (polled until the pill appears) shows the
 *  full Active Now list with roles. */
export const OpenList = () => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const btn = ref.current?.querySelector("button");
      if (btn) {
        btn.click();
        clearInterval(timer);
      }
    }, 120);
    const stop = setTimeout(() => clearInterval(timer), 4000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, []);
  return (
    <AuthProvider>
      <div ref={ref} className="flex h-[380px] w-[340px] justify-end bg-surface p-4">
        <PresenceIndicator />
      </div>
    </AuthProvider>
  );
};
