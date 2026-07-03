import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import "./mobile.css";

/* ------------------------------------------------------------------ *
 * Mobile Profile — the whole account experience with internal
 * sub-navigation (main + Personal details / Notifications / Language /
 * Help & support / My Team). Reproduces the owner's mobile design
 * (Houzs Mobile.html #profile + #p-* screens) 1:1, wired to the real
 * core backend.
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
 * ------------------------------------------------------------------ */

type Screen = "home" | "personal" | "notif" | "language" | "help" | "team";

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

// ── Component ──
export function MobileProfile({ onLogout }: { onLogout: () => void }) {
  const [screen, setScreen] = useState<Screen>("home");
  const { user } = useAuth();

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

  // Salesperson MTD scoreboard (v7 tiles: Orders MTD / Sales MTD) — the
  // caller's OWN sales orders this Malaysia-calendar month, from the SCM
  // backend. Self-scoped server-side (salesperson_id === caller). A non-sales
  // user simply sees 0 / RM 0.00.
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
  // Designer sub-line: "{position} · {venue}". We have no venue on /me, so the
  // honest analogue is position · department (the real org placement).
  const roleLine = [position || role, dept].filter(Boolean).join(" · ") || "Team member";
  // Designer layout VERBATIM (v7 MobileProfile.tsx): dark header, dark identity
  // card with initials avatar + name/sub, a 2-card stat row, an Account card of
  // plain rows (Personal details / Notifications / Language / My Team — matching
  // the design's 4 rows, no Password row), an App card, danger Log out, version
  // line. Wired to our real /me + roster. The stat row shows the design's
  // "Orders MTD / Sales MTD" from the caller's own sales orders this month.
  return (
    <div className="hz-m screen" style={{ background: "var(--app-bg)" }}>
      <header className="hdr" style={{ background: "#15161a", borderBottom: "none" }}>
        <div className="scr-title" style={{ color: "#fff" }}>Profile</div>
      </header>
      <div className="scroll hz-scroll" style={{ paddingBottom: 120 }}>
        <div className="card" style={{ background: "#15161a", border: "none" }}>
          <div className="card-b" style={{ display: "flex", alignItems: "center", gap: 13 }}>
            <span style={{ width: 52, height: 52, flex: "none", borderRadius: "50%", background: "#23242a", color: "#d8a85a", fontSize: 16, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{initials(name, user?.email)}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{name}</div>
              <div style={{ fontSize: 11.5, color: "#9aa093", marginTop: 2 }}>{roleLine}</div>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 9, margin: "12px 0" }}>
          <div className="card" style={{ flex: 1, margin: 0 }}><div className="card-b" style={{ textAlign: "center", padding: 11 }}><div className="money" style={{ fontSize: 15, fontWeight: 800 }}>{mtdOrders.toLocaleString("en-US")}</div><div className="fld-l" style={{ marginTop: 3 }}>Orders MTD</div></div></div>
          <div className="card" style={{ flex: 1, margin: 0 }}><div className="card-b" style={{ textAlign: "center", padding: 11 }}><div className="money" style={{ fontSize: 15, fontWeight: 800, color: "#a16a2e" }}>{"RM " + (mtdSalesCenti / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="fld-l" style={{ marginTop: 3 }}>Sales MTD</div></div></div>
        </div>

        <div className="fld-l" style={{ margin: "6px 2px 8px" }}>Account</div>
        <div className="card">
          <Item label="Personal details" onClick={() => setScreen("personal")} />
          <Item label="Notifications" onClick={() => setScreen("notif")} />
          <Item label="Language" right="English" onClick={() => setScreen("language")} />
          <Item label="My Team" onClick={() => setScreen("team")} />
        </div>

        <div className="fld-l" style={{ margin: "14px 2px 8px" }}>App</div>
        <div className="card">
          <Item label="Help & Support" onClick={() => setScreen("help")} />
        </div>

        <button className="btn btn-danger" style={{ marginTop: 16 }} onClick={onLogout}>Log out</button>
        <div className="money" style={{ textAlign: "center", fontSize: 10, color: "#a4a99c", marginTop: 12 }}>Houzs ERP · Mobile v1.0</div>
      </div>
    </div>
  );
}

// Designer's plain settings row (MobileProfile.tsx `Item`): label + optional
// right value, chevron glyph otherwise. Wired to our sub-screen navigation.
function Item({ label, right, onClick }: { label: string; right?: string; onClick: () => void }) {
  return (
    <div className="row" style={{ cursor: "pointer" }} onClick={onClick}>
      <span className="row-l" style={{ color: "#11140f", fontWeight: 600 }}>{label}</span>
      <span style={{ color: right ? "#767b6e" : "#c2c6bd", fontSize: right ? 13 : 16 }}>{right ?? "›"}</span>
    </div>
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
      <div className="money" style={{ textAlign: "center", fontSize: 10, color: "#a4a99c", marginTop: 14 }}>Houzs ERP · Mobile</div>
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
