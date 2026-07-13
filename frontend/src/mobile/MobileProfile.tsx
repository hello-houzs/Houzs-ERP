import { useMemo, useState } from "react";
import {
  HOUZS_COMPANY_CODE,
  getBrandingCache,
  getBrandingCompanyCode,
  shortCompanyName,
} from "../lib/branding";

/** Footer product label — HOUZS keeps the historic literal. */
function appFooterLabel(): string {
  return getBrandingCompanyCode() === HOUZS_COMPANY_CODE
    ? "Houzs ERP"
    : `${shortCompanyName(getBrandingCache().companyName)} ERP`;
}
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import "./mobile.css";

/* ------------------------------------------------------------------ *
 * Mobile Profile — the whole account experience with internal
 * sub-navigation (main + Personal details / Notifications / Language /
 * Help & support / My Team). Reproduces the owner's REAL mobile design
 * (deliverable/houzs-mobile.html #profile + #p-* screens) 1:1, wired to
 * the real core backend.
 *
 * Prototype (§34 "Profile & Settings") the home screen mirrors:
 *  - a DARK identity card (#15161a) with a radial-glow ring, initials
 *    avatar (58px, teal/gold), name, "{position} · {department}", and a
 *    third gold line "STAFF · {staff_code}";
 *  - a THREE-tile stat row;
 *  - Account rows WITH leading icons + right-side value (Personal details,
 *    Notifications "On", Language "English", My Team — role-gated);
 *  - an Organisation section (Inbox, Mail Center, Announcements, Members,
 *    Positions, Departments — moved here from the module menu, owner 2026-07
 *    "这全部在 profile 里面"; rows arrive pre-gated from MobileApp and navigate
 *    via its openRoute);
 *  - an App section (Help & Support);
 *  - a danger Log out (in-app confirm) + version footer.
 *
 * Backend wiring
 * --------------
 *  - Identity            : useAuth().user (hydrated once from
 *                          GET /api/auth/me).
 *  - Full member row     : GET /api/users (users.read) — carries phone,
 *                          department_name, position_name, manager_name
 *                          which the lean /me user object omits. We pick
 *                          our own row out by id. 403 (no users.read) is
 *                          handled gracefully; we fall back to the /me
 *                          fields we already have.
 *  - Stat tiles          : Orders/Sales MTD via
 *                          GET /api/scm/mfg-sales-orders/my-mtd (self-scoped);
 *                          Open cases via GET /api/assr/my-cases (count of
 *                          non-completed stages). Honest zeros when empty.
 *  - Self edit (name)    : PATCH /api/auth/me { name }  — the ONLY profile
 *                          field the backend lets a member self-edit. Phone /
 *                          department / role stay read-only ("request
 *                          change to HR"), mirroring the prototype's Edit
 *                          affordance.
 *  - Change password     : POST /api/auth/me/password { current, next } —
 *                          self-service, mirrors the desktop Profile page.
 *  - My Team             : reuses GET /api/users to build the reporting
 *                          line (manager) + downline (direct reports).
 *  - Notifications       : NO backend endpoint exists — persisted to
 *                          localStorage as per-device preferences
 *                          (keys hz_notif_*).
 *  - Language            : English-only ERP (no i18n layer) — informational.
 *  - Help & support      : static contact + guide rows.
 *
 * FLAGGED missing fields / APIs (do NOT fabricate — see report):
 *  - staff_code : NO such field on AuthUser or the /api/users row. The
 *    identity card's "STAFF · {staff_code}" line renders only when a real
 *    code exists; otherwise the line is omitted (never invented).
 *  - Points     : NO points_balance on AuthUser and no points API — the
 *    prototype's driver "Points" tile has no honest source, so it is not
 *    rendered.
 *  - Trips today: NO driver-trips API — the prototype's driver "Trips
 *    today" tile has no honest source, so it is not rendered.
 *    → The driver-specific tile set therefore falls back to the spec's
 *      Orders/Sales MTD + Open cases until those sources exist.
 * ------------------------------------------------------------------ */

type Screen = "home" | "personal" | "notif" | "language" | "help" | "team";

// The owner's directory (People > User Management) can carry a staff code
// under any of these keys depending on backend vintage. We read-through them
// all; if none is present we DO NOT invent one (the identity line is dropped).
const staffCodeOf = (r: (MemberRow & Record<string, unknown>) | null | undefined): string | null => {
  if (!r) return null;
  const cand = r.staff_code ?? r.staffCode ?? r.employee_code ?? r.employeeCode ?? r.staff_no ?? r.staffNo;
  const s = typeof cand === "string" ? cand.trim() : cand != null ? String(cand) : "";
  return s || null;
};

// Subset of the /api/users row (TeamMember) we consume here. Every field
// optional so a leaner/older backend never crashes the screen.
type MemberRow = {
  id: number;
  email: string;
  name: string | null;
  status?: string | null;
  role_name?: string | null;
  manager_id?: number | null;
  manager_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  department_color?: string | null;
  position_id?: number | null;
  position_name?: string | null;
  phone?: string | null;
  email_alias?: string | null;
  // Staff code is not part of the shipped /api/users contract; these keys are
  // read opportunistically (FLAGGED missing — see header comment). All optional.
  staff_code?: string | null;
  staffCode?: string | null;
  employee_code?: string | null;
  employeeCode?: string | null;
  staff_no?: string | null;
  staffNo?: string | null;
};

// ── Shared formatters / helpers ──
const initials = (name: string | null | undefined, email?: string): string => {
  const src = (name || "").trim() || (email || "").split("@")[0] || "";
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// A stable colour per person for the initial avatar (matches the design's
// teal-family palette).
const AVATAR_COLORS = ["#16695f", "#2f7d70", "#3d6b8a", "#8a6a3d", "#7a5c86", "#4d7a55"];
const avatarColor = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
};

// Roles that see My Team (upline + downline) — salespeople & managers, per §34.
// A manager is anyone who has direct reports; sales roles are matched by name.
const isSalesish = (roleName: string | null | undefined): boolean =>
  /sales|manager|lead|head|director|admin|owner|super/i.test(roleName || "");

// Organisation rows — owner 2026-07: Inbox / Mail Center / Announcements /
// Members / Positions / Departments live HERE, not in the module menu
// ("这全部在 profile 里面"). MobileApp passes the item list already filtered by
// the SAME per-item permission gate the menu used (`orgItems`) plus its
// `openRoute` navigator (`onOpenOrg`), so routing + gating stay identical to
// the old menu entries.
type OrgItem = { to: string; label: string };

// ── Component ──
export function MobileProfile({ onLogout, orgItems, onOpenOrg }: {
  onLogout: () => void;
  /** Organisation destinations, pre-filtered by MobileApp's `allowed` gate. */
  orgItems?: OrgItem[];
  /** MobileApp's openRoute(to, label) — same navigation the menu items used. */
  onOpenOrg?: (to: string, label: string) => void;
}) {
  const [screen, setScreen] = useState<Screen>("home");
  const { user } = useAuth();
  const confirm = useConfirm();

  // The full team roster — used both for the richer Personal-details fields
  // (phone / department / position) and for My Team. Gated by users.read on
  // the backend: a 403 lands in `error`, which every consumer treats as
  // "no team directory available" rather than a crash.
  const teamQ = useQuery({
    queryKey: ["mobile-profile-users"],
    queryFn: () => api.get<{ users: MemberRow[] }>("/api/users"),
    staleTime: 60_000,
    retry: false,
  });
  const roster = teamQ.data?.users ?? [];
  const myRow = useMemo(
    () => roster.find((r) => r.id === user?.id) ?? null,
    [roster, user?.id],
  );

  // Announcements unread count — this user's audience-matching notices (incl.
  // the private scan-result notices, target USER_IDS) minus what they've acked.
  // Drives the red pill on the Organisation → Announcements row so it reads like
  // a notification. Polls 30s; fail-soft (a hiccup just shows no badge).
  const bannerQ = useQuery({
    queryKey: ["mobile-profile-ann-unread"],
    queryFn: () => api.get<{ data?: { id: string }[]; ackedIds?: string[] }>("/api/announcements/banner"),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  const annUnread = useMemo(() => {
    const items = bannerQ.data?.data ?? [];
    const acked = new Set(bannerQ.data?.ackedIds ?? []);
    return items.filter((a) => !acked.has(a.id)).length;
  }, [bannerQ.data]);

  // Salesperson MTD scoreboard (Orders MTD / Sales MTD) — the caller's OWN
  // sales orders this Malaysia-calendar month, from the SCM backend.
  // Self-scoped server-side (salesperson_id === caller). A non-sales user
  // simply sees 0 / RM 0.00 (honest zero).
  const mtdQ = useQuery({
    queryKey: ["mobile-profile-mtd"],
    queryFn: () =>
      api.get<{ mtd_orders?: number; mtd_sales_centi?: number }>(
        "/api/scm/mfg-sales-orders/my-mtd",
      ),
    staleTime: 60_000,
    retry: false,
  });
  const mtdOrders = Number(mtdQ.data?.mtd_orders ?? 0);
  const mtdSalesCenti = Number(mtdQ.data?.mtd_sales_centi ?? 0);

  // Open service cases assigned to the caller (third stat tile) — the same
  // self-scoped list the desktop "My Cases" page reads. "Open" = any stage
  // that isn't completed. 403 / empty → honest 0.
  const casesQ = useQuery({
    queryKey: ["mobile-profile-mycases"],
    queryFn: () => api.get<{ cases: { stage: string }[] }>("/api/assr/my-cases"),
    staleTime: 60_000,
    retry: false,
  });
  const openCases = (casesQ.data?.cases ?? []).filter((c) => c.stage !== "completed").length;

  // My Team is role-gated (§34): salespeople / managers, or anyone with an
  // upline / downline in the directory. Computed BEFORE the sub-screen early
  // returns so the hook order stays stable across renders.
  const hasDownline = useMemo(
    () => roster.some((r) => r.manager_id === user?.id && r.id !== user?.id),
    [roster, user?.id],
  );

  if (screen === "personal") {
    return <PersonalScreen onBack={() => setScreen("home")} myRow={myRow} />;
  }
  if (screen === "notif") {
    return <NotificationsScreen onBack={() => setScreen("home")} />;
  }
  if (screen === "language") {
    return <LanguageScreen onBack={() => setScreen("home")} />;
  }
  if (screen === "help") {
    return <HelpScreen onBack={() => setScreen("home")} />;
  }
  if (screen === "team") {
    return (
      <TeamScreen
        onBack={() => setScreen("home")}
        roster={roster}
        me={myRow}
        loading={teamQ.isLoading}
        denied={!!teamQ.error}
      />
    );
  }

  // ── Home ──
  const name = user?.name || myRow?.name || "—";
  const role = user?.role_name || myRow?.role_name || null;
  const dept = myRow?.department_name || null;
  const position = myRow?.position_name || null;
  // Prototype sub-line: "{position} · {department}" (real org placement; the
  // README's "{position} · {venue}" has no venue on /me, so department is the
  // honest analogue).
  const roleLine = [position || role, dept].filter(Boolean).join(" · ") || "Team member";
  // Identity card's gold third line "STAFF · {staff_code}". Rendered ONLY when a
  // real code exists (FLAGGED: no staff_code in the backend contract today).
  const staffCode = staffCodeOf(myRow as (MemberRow & Record<string, unknown>) | null);
  const showTeam = isSalesish(role) || !!myRow?.manager_id || hasDownline;

  const notifOn = anyNotifOn();

  const doLogout = async () => {
    if (await confirm({ title: "Log out of Houzs ERP?", confirmLabel: "Log out", danger: true })) {
      onLogout();
    }
  };

  const mtdSales = "RM " + (mtdSalesCenti / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Prototype #profile VERBATIM: DARK header eyebrow "Account" + "Profile" +
  // a settings icon button, DARK identity card (#15161a) with a radial-glow
  // ring, 58px initials avatar, name, "{position} · {dept}", and a gold
  // "STAFF · {code}" line; a THREE-tile stat row; Account rows WITH leading
  // icons + right value; App section; danger Log out (in-app confirm); footer.
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Account</div>
            <div className="scr-title">Profile</div>
          </div>
          <button type="button" className="iconbtn" onClick={() => setScreen("personal")} aria-label="Personal details">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.3 2.6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L5 11a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.4h5l.3-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6Z" /></svg>
          </button>
        </div>
      </header>
      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {/* Dark identity card */}
        <div style={{ position: "relative", overflow: "hidden", borderRadius: 18, background: "#15161a", padding: "20px 18px", boxShadow: "0 12px 32px -16px rgba(17,24,16,.45)" }}>
          <div style={{ position: "absolute", right: -50, top: -60, width: 200, height: 200, borderRadius: "50%", background: "radial-gradient(circle,rgba(22,105,95,.55),transparent 70%)", pointerEvents: "none" }} />
          <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ width: 58, height: 58, flex: "none", borderRadius: "50%", background: "#16695f", border: "2px solid rgba(216,168,90,.5)", color: "#d8a85a", fontSize: 20, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{initials(name, user?.email)}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 19, fontWeight: 800, color: "#fff", lineHeight: 1.15 }}>{name}</div>
              <div style={{ fontSize: 12.5, color: "rgba(231,234,228,.82)", marginTop: 3 }}>{roleLine}</div>
              {staffCode && (
                <div className="money" style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: "#d8a85a", marginTop: 6 }}>{"STAFF · " + staffCode}</div>
              )}
            </div>
          </div>
        </div>

        {/* Three stat tiles (all wired to real, self-scoped sources) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9, marginTop: 13 }}>
          <StatTile value={mtdOrders.toLocaleString("en-US")} label="Orders MTD" />
          <StatTile value={mtdSales} label="Sales MTD" color="#a16a2e" />
          <StatTile value={openCases.toLocaleString("en-US")} label="Open cases" />
        </div>

        <div className="ey" style={{ color: "#767b6e", margin: "18px 2px 9px" }}>Account</div>
        <div className="card" style={{ overflow: "hidden" }}>
          <Item icon="users" label="Personal details" onClick={() => setScreen("personal")} first />
          <Item icon="mega" label="Notifications" right={notifOn ? "On" : "Off"} onClick={() => setScreen("notif")} />
          <Item icon="list" label="Language" right="English" onClick={() => setScreen("language")} />
          {showTeam && <Item icon="users" label="My Team" onClick={() => setScreen("team")} />}
        </div>

        {/* Organisation — moved here from the module menu (owner 2026-07).
            Same routes + permission gating as the old menu entries; rows use
            the SAME Item pattern (icon + label + chevron) as Account above. */}
        {onOpenOrg && (orgItems?.length ?? 0) > 0 && (
          <>
            <div className="ey" style={{ color: "#767b6e", margin: "18px 2px 9px" }}>Organisation</div>
            <div className="card" style={{ overflow: "hidden" }}>
              {(orgItems ?? []).map((it, i) => (
                <Item key={it.to} icon={orgIconOf(it.to)} label={it.label} onClick={() => onOpenOrg(it.to, it.label)} first={i === 0}
                  badge={it.to === "/announcements" ? annUnread : undefined} />
              ))}
            </div>
          </>
        )}

        <div className="ey" style={{ color: "#767b6e", margin: "18px 2px 9px" }}>App</div>
        <div className="card" style={{ overflow: "hidden" }}>
          <Item icon="shield" label="Help & Support" onClick={() => setScreen("help")} first />
        </div>

        <button type="button" className="btn-danger" style={{ marginTop: 16 }} onClick={doLogout}>Log out</button>
        <div className="money" style={{ textAlign: "center", fontSize: 10, color: "#a4a99c", marginTop: 12 }}>{appFooterLabel()} · Mobile v1.0</div>
      </div>
    </div>
  );
}

// One stat tile in the profile's 3-up row (prototype #profile). White card,
// big tabular number, uppercase caption.
function StatTile({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #d6d9d2", borderRadius: 12, padding: 13, textAlign: "center" }}>
      <div className="tnum" style={{ fontSize: 24, fontWeight: 800, color: color ?? "#11140f", lineHeight: 1 }}>{value}</div>
      <div className="ey" style={{ color: "#767b6e", marginTop: 6 }}>{label}</div>
    </div>
  );
}

// Leading SVG icons for the Account / Organisation / App rows (prototype
// `micon` glyphs + same-style glyphs for the Organisation rows).
const ROW_ICONS: Record<string, React.ReactNode> = {
  users: (<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /></>),
  mega: (<><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M16 8a4 4 0 0 1 0 8" /></>),
  list: (<path d="M5 4h14M5 9h14M5 14h14M5 19h9" />),
  shield: (<><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z" /><path d="m9 12 2 2 4-4" /></>),
  inbox: (<><path d="M22 12h-5.5l-2 3h-5l-2-3H2" /><path d="M5.4 5.6 2 12v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5l-3.4-6.4A2 2 0 0 0 16.8 4.5H7.2a2 2 0 0 0-1.8 1.1Z" /></>),
  mail: (<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>),
  cast: (<><path d="M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2" /><circle cx="12" cy="12" r="1.6" /></>),
  badge: (<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M15 8.5h4M15 12h4M5.8 16.5a3.2 3.2 0 0 1 6.4 0" /></>),
  building: (<><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" /></>),
};

// Route → row icon for the Organisation section (falls back to a plain list
// glyph for any future route without a bespoke icon).
const ORG_ROW_ICONS: Record<string, keyof typeof ROW_ICONS> = {
  "/activity-inbox": "inbox",
  "/mail-center": "mail",
  "/announcements": "cast",
  "/team?tab=members": "users",
  "/team?tab=positions": "badge",
  "/team?tab=departments": "building",
};
const orgIconOf = (to: string): keyof typeof ROW_ICONS => ORG_ROW_ICONS[to] ?? "list";

// Prototype `profRow`: leading icon chip + label + optional right value +
// chevron. Wired to our sub-screen navigation.
function Item({ icon, label, right, onClick, first, badge }: { icon: keyof typeof ROW_ICONS; label: string; right?: string; onClick: () => void; first?: boolean; badge?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", background: "none", border: "none", borderTop: first ? "none" : "1px solid #e3e6e0", padding: "12px 13px", cursor: "pointer", fontFamily: "inherit" }}
    >
      <span style={{ width: 34, height: 34, flex: "none", borderRadius: 9, background: "#f4f6f3", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ROW_ICONS[icon]}</svg>
      </span>
      <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: "#11140f" }}>{label}</span>
      {/* Unread count pill — notification-style. Only rendered when > 0. */}
      {badge != null && badge > 0 && (
        <span style={{ flex: "none", minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9, background: "#c0392b", color: "#fff", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {right && <span style={{ fontSize: 12, color: "#9aa093" }}>{right}</span>}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c2c6bd" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
    </button>
  );
}

// ── Reusable sub-screen shell (back header) ──
function SubScreen({ title, sub, onBack, right, children }: {
  title: string;
  sub?: string;
  onBack: () => void;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back">
            <span className="chev">{"‹"}</span> Profile
          </button>
          {right}
        </div>
        <div className="scr-title" style={{ marginTop: 7 }}>{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{sub}</div>}
      </header>
      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 120 }}>
        {children}
      </div>
    </div>
  );
}

// ── Personal details ──
function PersonalScreen({ onBack, myRow }: { onBack: () => void; myRow: MemberRow | null }) {
  const { user, reload } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState<string>(user?.name || myRow?.name || "");
  const [err, setErr] = useState<string | null>(null);

  const saveName = useMutation({
    mutationFn: (name: string) => api.patch<{ ok: boolean }>("/api/auth/me", { name }),
    onSuccess: async () => {
      setErr(null);
      setEditing(false);
      await reload();
      qc.invalidateQueries({ queryKey: ["mobile-profile-users"] });
    },
    onError: (e: any) => setErr(e?.message || "Couldn't save. Try again."),
  });

  const name = user?.name || myRow?.name || "—";
  const email = user?.email || myRow?.email || "—";
  const role = user?.role_name || myRow?.role_name || "—";
  const dept = myRow?.department_name || "—";
  const position = myRow?.position_name || "—";
  const phone = myRow?.phone || null;
  const alias = user?.email_alias || myRow?.email_alias || null;
  const staffCode = staffCodeOf(myRow as (MemberRow & Record<string, unknown>) | null);

  return (
    <SubScreen
      title="Personal details"
      onBack={onBack}
      right={
        !editing ? (
          <button
            onClick={() => { setNameDraft(user?.name || myRow?.name || ""); setEditing(true); }}
            style={tinyBtn}
          >
            Edit name
          </button>
        ) : (
          <button onClick={() => { setEditing(false); setErr(null); }} style={tinyBtn}>Cancel</button>
        )
      }
    >
      {editing ? (
        <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 14, padding: 14, marginBottom: 16 }}>
          <div style={kvLabel}>Display name</div>
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="Your name"
            style={{ width: "100%", marginTop: 6, border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", fontFamily: "inherit", fontSize: 14, color: "var(--ink)", outline: "none" }}
          />
          {err && <div style={{ fontSize: 11.5, color: "#b23a3a", marginTop: 8 }}>{err}</div>}
          <button
            onClick={() => { const n = nameDraft.trim(); if (n) saveName.mutate(n); }}
            disabled={saveName.isPending || !nameDraft.trim()}
            style={{ width: "100%", marginTop: 12, background: "var(--teal)", color: "#fff", border: "none", borderRadius: 11, padding: "12px", fontSize: 13.5, fontWeight: 700, fontFamily: "inherit", cursor: saveName.isPending ? "default" : "pointer", opacity: saveName.isPending || !nameDraft.trim() ? 0.6 : 1 }}
          >
            {saveName.isPending ? "Saving…" : "Save name"}
          </button>
          <div style={{ fontSize: 11, color: "#9aa093", marginTop: 10, lineHeight: 1.5 }}>
            Only your display name is self-editable. For any other change (phone, department, role) please request an update from HR.
          </div>
        </div>
      ) : (
        <>
          <div style={sectionLabel}>Identity</div>
          <div style={{ ...pgrid2, marginBottom: 16 }}>
            <KV label="Name" value={name} span />
            {staffCode && <KV label="Staff code" value={staffCode} mono span />}
            <KV label="Role" value={role} />
            <KV label="Position" value={position} />
            <KV label="Department" value={dept} span />
          </div>

          <div style={sectionLabel}>Contact</div>
          <div style={{ ...pgrid2, marginBottom: 16 }}>
            <KV label="Phone" value={phone || "Not on file"} mono={!!phone} span />
            <KV label="Email" value={email} span />
            {alias && <KV label="Mail alias" value={alias} span />}
          </div>

          <div style={{ fontSize: 11, color: "#9aa093", lineHeight: 1.5, padding: "0 2px" }}>
            These details come from your HR record. To change your phone, department, or role, request an update from HR — you can edit only your display name here.
          </div>
        </>
      )}
    </SubScreen>
  );
}

// ── Notifications (device-local prefs) ──
const NOTIF_KEY = "hz_notif_";
type NotifPref = { key: string; label: string; sub: string; def: boolean };
const NOTIF_PREFS: NotifPref[] = [
  { key: "push", label: "Push notifications", sub: "Master switch for this device", def: true },
  { key: "sla", label: "SLA breach alerts", sub: "Service cases nearing deadline", def: true },
  { key: "so", label: "New SO assigned", sub: "When an order is routed to you", def: true },
  { key: "pay", label: "Payments & invoices", sub: "Overdue + collection reminders", def: false },
  { key: "mail", label: "Mail Center", sub: "New mail to your mailboxes", def: true },
  { key: "ann", label: "Announcements", sub: "Company-wide notices", def: true },
];

const readNotif = (p: NotifPref): boolean => {
  try {
    const v = localStorage.getItem(NOTIF_KEY + p.key);
    return v == null ? p.def : v === "1";
  } catch {
    return p.def;
  }
};

// Right-hand "On" / "Off" state for the Account > Notifications row — reflects
// the device's master push switch (the first pref), matching the prototype's
// "On" affordance.
const anyNotifOn = (): boolean => {
  const master = NOTIF_PREFS.find((p) => p.key === "push");
  return master ? readNotif(master) : true;
};

function NotificationsScreen({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<Record<string, boolean>>(() => {
    const o: Record<string, boolean> = {};
    for (const p of NOTIF_PREFS) o[p.key] = readNotif(p);
    return o;
  });

  const toggle = (key: string) => {
    setState((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(NOTIF_KEY + key, next[key] ? "1" : "0"); } catch {}
      return next;
    });
  };

  return (
    <SubScreen title="Notifications" onBack={onBack}>
      <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden" }}>
        {NOTIF_PREFS.map((p, i) => (
          <label
            key={p.key}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", cursor: "pointer", borderTop: i === 0 ? "none" : "1px solid #e3e6e0" }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{p.label}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>{p.sub}</div>
            </div>
            <input
              type="checkbox"
              checked={state[p.key]}
              onChange={() => toggle(p.key)}
              style={{ width: 20, height: 20, accentColor: "var(--teal)" }}
            />
          </label>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#9aa093", marginTop: 11, textAlign: "center", lineHeight: 1.5 }}>
        Notification preferences are saved on this device.
      </div>
    </SubScreen>
  );
}

// ── Language (informational — English-only ERP) ──
function LanguageScreen({ onBack }: { onBack: () => void }) {
  const options: { code: string; label: string; enabled: boolean }[] = [
    { code: "en", label: "English", enabled: true },
    { code: "ms", label: "Bahasa Malaysia", enabled: false },
    { code: "zh", label: "Chinese", enabled: false },
  ];
  return (
    <SubScreen title="Language" onBack={onBack}>
      <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden" }}>
        {options.map((o, i) => (
          <div
            key={o.code}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 14px", borderTop: i === 0 ? "none" : "1px solid #e3e6e0", opacity: o.enabled ? 1 : 0.55 }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{o.label}</div>
              {!o.enabled && <div style={{ fontSize: 11, color: "var(--muted)" }}>Coming soon</div>}
            </div>
            {o.enabled ? (
              <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--teal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
            ) : (
              <span style={{ width: 22, height: 22, borderRadius: "50%", border: "2px solid var(--line)" }} />
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#9aa093", marginTop: 11, textAlign: "center", lineHeight: 1.5 }}>
        UI copy stays English to match the live ERP. Dates and numbers follow the Malaysia format.
      </div>
    </SubScreen>
  );
}

// ── Help & support (static) ──
function HelpScreen({ onBack }: { onBack: () => void }) {
  return (
    <SubScreen title="Help & support" onBack={onBack}>
      <div style={sectionLabel}>Get in touch</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 18 }}>
        <a
          href="mailto:operation@houzscentury.com"
          style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid var(--line)", borderRadius: 13, padding: "13px 14px", textDecoration: "none" }}
        >
          <span style={{ width: 34, height: 34, flex: "none", borderRadius: 9, background: "#e1efed", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
          </span>
          <span style={{ flex: 1 }}>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>Email support</span>
            <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>operation@houzscentury.com</span>
          </span>
          <span style={{ color: "#c2c6bd" }}>{"›"}</span>
        </a>
        <a
          href="tel:+60327108800"
          style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid var(--line)", borderRadius: 13, padding: "13px 14px", textDecoration: "none" }}
        >
          <span style={{ width: 34, height: 34, flex: "none", borderRadius: 9, background: "#f3ece0", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.5a16 16 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" /></svg>
          </span>
          <span style={{ flex: 1 }}>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>Call operations</span>
            <span className="money" style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>+60 3-2710 8800</span>
          </span>
          <span style={{ color: "#c2c6bd" }}>{"›"}</span>
        </a>
      </div>

      <div style={sectionLabel}>Guides</div>
      <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden" }}>
        {["Creating a Sales Order", "Scanning order slips (OCR)", "Logging a service case"].map((g, i) => (
          <div
            key={g}
            style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "12px 13px", borderTop: i === 0 ? "none" : "1px solid #e3e6e0" }}
          >
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{g}</span>
            <span style={{ color: "#c2c6bd" }}>{"›"}</span>
          </div>
        ))}
      </div>
      <div className="money" style={{ textAlign: "center", fontSize: 10, color: "#a4a99c", marginTop: 14 }}>{appFooterLabel()} · Mobile</div>
    </SubScreen>
  );
}

// ── My Team (reporting line + downline) ──
function TeamScreen({ onBack, roster, me, loading, denied }: {
  onBack: () => void;
  roster: MemberRow[];
  me: MemberRow | null;
  loading: boolean;
  denied: boolean;
}) {
  const activeOnly = (r: MemberRow) => (r.status ?? "active") !== "disabled";

  const manager = useMemo(
    () => (me?.manager_id ? roster.find((r) => r.id === me.manager_id) ?? null : null),
    [roster, me?.manager_id],
  );
  const downline = useMemo(
    () => (me ? roster.filter((r) => r.manager_id === me.id && r.id !== me.id && activeOnly(r)) : []),
    [roster, me],
  );

  return (
    <SubScreen title="My Team" sub="Your reporting line & downline" onBack={onBack}>
      {loading && <div style={emptyState}>Loading team…</div>}
      {!loading && denied && (
        <div style={emptyState}>The team directory isn't available for your account.</div>
      )}
      {!loading && !denied && (
        <>
          <div style={sectionLabel}>Reporting line</div>
          <div style={{ marginBottom: 18 }}>
            {manager ? (
              <PersonCard person={manager} caption="Reports to" />
            ) : (
              <div style={emptyStateSmall}>
                {me?.manager_name || "No manager on record."}
              </div>
            )}
          </div>

          <div style={sectionLabel}>{`My downline${downline.length ? ` (${downline.length})` : ""}`}</div>
          {downline.length === 0 ? (
            <div style={emptyStateSmall}>No direct reports.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {downline.map((p) => (
                <PersonCard key={p.id} person={p} />
              ))}
            </div>
          )}
        </>
      )}
    </SubScreen>
  );
}

function PersonCard({ person, caption }: { person: MemberRow; caption?: string }) {
  const name = person.name || person.email.split("@")[0];
  const sub = person.position_name || person.role_name || person.department_name || "";
  const seed = String(person.id) + (person.email || "");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, background: "#fff", border: "1px solid var(--line)", borderRadius: 13, padding: "11px 13px" }}>
      <span style={{ width: 40, height: 40, flex: "none", borderRadius: "50%", background: avatarColor(seed), color: "#fff", fontSize: 14, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {initials(person.name, person.email)}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {caption && <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093" }}>{caption}</div>}
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
        {sub && <div style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>}
      </div>
    </div>
  );
}

function KV({ label, value, span, mono }: { label: string; value: string; span?: boolean; mono?: boolean }) {
  return (
    <div style={span ? { gridColumn: "1 / -1" } : undefined}>
      <div style={kvLabel}>{label}</div>
      <div className={mono ? "money" : undefined} style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", marginTop: 3, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

// ── Shared style objects ──
const pgrid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };
const sectionLabel: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase", color: "var(--muted)", margin: "0 2px 8px" };
const kvLabel: React.CSSProperties = { fontSize: 8.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093" };
const tinyBtn: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--teal)", background: "#fff", border: "1px solid var(--line)", borderRadius: 9, padding: "6px 12px", cursor: "pointer", fontFamily: "inherit" };
const emptyState: React.CSSProperties = { textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" };
const emptyStateSmall: React.CSSProperties = { fontSize: 12.5, color: "#9aa093", background: "#fff", border: "1px dashed var(--line)", borderRadius: 12, padding: "14px", textAlign: "center" };
