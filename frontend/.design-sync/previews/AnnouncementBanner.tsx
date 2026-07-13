import { AuthProvider, AnnouncementBanner } from "autocount-sync-frontend";

// AnnouncementBanner is a CONNECTED component: it takes no props, needs the
// auth context and fetches /api/announcements/banner itself. This preview
// renders the real component by stubbing the network layer: a fake bearer
// token + canned JSON for the three endpoints the mount path hits.
//
// The API GET cache dedupes same-path requests within one page, so a single
// page can only ever show ONE category. Each story therefore picks its
// category from the ?story= param (the capture harness loads each story on
// its own page); the grid card is pinned to the Warning story via
// cfg.overrides.AnnouncementBanner = { cardMode: "single" }.

const STORY_CATEGORY: Record<string, string> = {
  General: "GENERAL",
  Warning: "WARNING",
  Sop: "SOP",
  Learning: "LEARNING",
};

const CONTENT: Record<string, { title: string; body: string }> = {
  GENERAL: {
    title: "Office closed this Friday for Hari Raya Haji",
    body: "Deliveries scheduled for Friday move to Saturday morning. Check with logistics for affected orders.",
  },
  WARNING: {
    title: "AutoCount sync paused — do not edit stock levels manually",
    body: "Pending reconciliation. Manual adjustments will be overwritten when sync resumes.",
  },
  SOP: {
    title: "Updated delivery photo SOP — 4 photos required per drop-off",
    body: "Front door, unit placement, serial sticker, and signed DO. Effective immediately.",
  },
  LEARNING: {
    title: "New training video: handling ASSR quality disputes",
    body: "12 minutes. Required for all service crew before end of month.",
  },
};

const story =
  new URLSearchParams(window.location.search).get("story") || "Warning";
const category = STORY_CATEGORY[story] ?? "WARNING";

// Fresh session for every render: fake token in, stale local acks out.
try {
  localStorage.setItem("auth:token", "ds-preview-token");
  localStorage.removeItem("announcements:localAcks");
} catch {}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/auth/status")) return json({ has_users: true });
  if (url.includes("/api/auth/me"))
    return json({ user: { id: "u_preview", name: "Design Preview", email: "preview@houzs.local" } });
  if (url.includes("/api/announcements/banner"))
    return json({
      success: true,
      data: [
        {
          id: `ann-${category.toLowerCase()}`,
          title: CONTENT[category].title,
          body: CONTENT[category].body,
          createdAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
          remindedAt: null,
          category,
        },
      ],
      ackedIds: [],
    });
  if (url.includes("/api/announcements/") && url.endsWith("/ack")) return json({ success: true });
  // Unstubbed API paths must NOT fall through: the DS bundle's baseUrl points
  // at the real workers.dev API, and a genuine 401 there fires the global
  // logout listener — wiping the preview auth token mid-render.
  if (url.includes("/api/"))
    return new Response(JSON.stringify({ error: "not stubbed in preview" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  return realFetch(input as RequestInfo, init);
};

const Live = () => (
  <AuthProvider>
    <div className="w-[42rem]">
      <AnnouncementBanner />
    </div>
  </AuthProvider>
);

export const Warning = () => <Live />;
export const General = () => <Live />;
export const Sop = () => <Live />;
export const Learning = () => <Live />;
