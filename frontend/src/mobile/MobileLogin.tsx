import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import "./mobile.css";

const REMEMBER_KEY = "houzs_remember_email";

/** Mobile login — 1:1 with the owner's design: dark surface, drifting aurora
 *  glows, ambient snow particles, staggered entrance. Wired to the real auth:
 *  Remember me persists the email, Forgot password opens the reset flow, Sign in
 *  authenticates (incl. 2FA challenge). */
export function MobileLogin() {
  const { login, verifyTotpLogin } = useAuth();
  const remembered = typeof localStorage !== "undefined" ? localStorage.getItem(REMEMBER_KEY) : null;
  const [email, setEmail] = useState(remembered ?? "");
  const [password, setPassword] = useState("");
  // Default Remember me ON — internal ERP, staff expect to stay signed in (7-day
  // session). Was `remembered != null`, which left it UNCHECKED on a fresh/cleared
  // device → the token went to sessionStorage and was lost on app close, forcing a
  // re-login every open. Default true → token persists in localStorage.
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  /* Nick 2026-07-09 — show-password toggle on both login + code steps. */
  const [showPw, setShowPw] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ---- ambient snow (ported from the design prototype) ----
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    let W = 0, H = 0, DPR = 1, last = 0, raf = 0;
    let parts: { x: number; y: number; r: number; sp: number; sw: number; ph: number; a: number; brass: boolean }[] = [];
    const mk = (any: boolean) => ({
      x: Math.random() * W, y: any ? Math.random() * H : -6,
      r: 0.6 + Math.random() * 2.0, sp: 4 + Math.random() * 12, sw: 0.25 + Math.random() * 0.7,
      ph: Math.random() * 6.28, a: 0.05 + Math.random() * 0.2, brass: Math.random() < 0.16,
    });
    const resize = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = cv.getBoundingClientRect();
      W = r.width || 366; H = r.height || 760;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    const seed = () => {
      const n = Math.max(34, Math.min(70, Math.round((W * H) / 9000)));
      parts = Array.from({ length: n }, () => mk(true));
    };
    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.y += p.sp * dt; p.x += Math.sin((t / 1000) * p.sw + p.ph) * 0.2;
        if (p.y > H + 6) parts[i] = mk(false);
        ctx.beginPath(); ctx.globalAlpha = p.a;
        ctx.fillStyle = p.brass ? "#d8a85a" : "#cfe6df";
        ctx.shadowColor = p.brass ? "rgba(216,168,90,.5)" : "rgba(180,220,210,.5)";
        ctx.shadowBlur = p.r * 2.6;
        ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      raf = requestAnimationFrame(frame);
    };
    resize(); seed();
    const onResize = () => { resize(); seed(); };
    window.addEventListener("resize", onResize);
    last = performance.now();
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, []);

  async function onSignIn() {
    if (busy) return;
    setErr(null); setBusy(true);
    try {
      if (remember) localStorage.setItem(REMEMBER_KEY, email.trim());
      else localStorage.removeItem(REMEMBER_KEY);
      const res = await login(email.trim(), password, remember);
      if (res.kind === "totp") { setChallenge(res.challenge); setBusy(false); }
      // res.kind === "ok": AuthContext sets the user; AuthGate swaps to the app.
    } catch (e) {
      // Wrong password (401) → the owner's preferred specific wording, not
      // the generic backend "Invalid credentials". Other errors keep their
      // already-humanized message.
      const status = (e as { status?: number } | null)?.status;
      setErr(status === 401 ? "Password incorrect." : (e instanceof Error ? e.message : "Sign in failed. Check your details."));
      setBusy(false);
    }
  }

  async function onVerify() {
    if (busy || !challenge) return;
    setErr(null); setBusy(true);
    try {
      await verifyTotpLogin(challenge, code.trim(), remember);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Invalid code.");
      setBusy(false);
    }
  }

  const labelStyle: React.CSSProperties = { display: "block", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "rgba(231,234,228,.55)", marginBottom: 6 };
  // fontSize MUST be >= 16 — iOS Safari auto-zooms the page when a focused input's
  // font is under 16px (that's the "page keeps zooming when I type" bug).
  const inputStyle: React.CSSProperties = { width: "100%", background: "rgba(255,255,255,.07)", border: "1px solid rgba(231,234,228,.18)", borderRadius: 12, padding: "13px 14px", color: "#fff", fontFamily: "inherit", fontSize: 16, outline: "none" };
  const delay = (i: number): React.CSSProperties => ({ animationDelay: `${0.05 + i * 0.07}s` });

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--dark)", overflow: "hidden" }}>
      <div className="hz-glow" style={{ position: "absolute", right: -70, top: -50, width: 260, height: 260, borderRadius: "50%", background: "radial-gradient(circle,rgba(22,105,95,.5),transparent 70%)", pointerEvents: "none" }} />
      <div className="hz-glow hz-glow-b" style={{ position: "absolute", left: -90, bottom: -30, width: 220, height: 220, borderRadius: "50%", background: "radial-gradient(circle,rgba(161,106,46,.22),transparent 70%)", pointerEvents: "none" }} />
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />

      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: "34px 28px", maxWidth: 460, margin: "0 auto" }}>
        {/* Brand lockup — rounded-square app icon holding the real HC mark
            (black-on-transparent PNG inverted to cream, same trick as the
            desktop AuthShell), "Houzs Century" title, "ERP · MOBILE" gold
            eyebrow. Wrapped in our entrance-animation items. */}
        <div className="appicon hz-lg-item" style={{ ...delay(0), width: 70, height: 70, borderRadius: 20, background: "linear-gradient(160deg,#23242a,#0e0f12)", marginBottom: 22, boxShadow: "inset 0 0 0 1px rgba(216,168,90,.16)" }}>
          <img src="/logo-hc-mark.png" alt="Houzs Century" style={{ width: 36, height: 36, objectFit: "contain", filter: "brightness(0) invert(1)" }} />
        </div>
        <div className="hz-lg-item" style={{ ...delay(1), fontSize: 26, fontWeight: 800, color: "#fff" }}>Houzs Century</div>
        <div className="hz-lg-item" style={{ ...delay(1), fontSize: 8.5, fontWeight: 700, letterSpacing: ".34em", color: "var(--gold)", marginTop: 6 }}>ERP · MOBILE</div>
        <div className="hz-lg-item" style={{ ...delay(2), fontSize: 14.5, color: "rgba(231,234,228,.78)", marginTop: 24, lineHeight: 1.5 }}>
          {challenge ? "Enter your 6-digit code" : "Sign in to your workspace"}
        </div>

        {!challenge ? (
          <>
            <div className="hz-lg-item" style={{ ...delay(3), display: "flex", flexDirection: "column", gap: 13, marginTop: 18 }}>
              <label style={{ display: "block" }}>
                <span style={labelStyle}>Email or phone</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" autoCorrect="off" inputMode="email"
                  onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("hz-pw")?.focus(); }} style={inputStyle} placeholder="you@houzscentury.com" />
              </label>
              <label style={{ display: "block" }}>
                <span style={labelStyle}>Password</span>
                <div style={{ position: "relative" }}>
                  <input id="hz-pw" type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") onSignIn(); }} style={{ ...inputStyle, paddingRight: 44 }} placeholder="••••••••" />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    aria-label={showPw ? "Hide password" : "Show password"}
                    title={showPw ? "Hide password" : "Show password"}
                    tabIndex={-1}
                    style={{
                      position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                      width: 32, height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center",
                      background: "transparent", border: "none", borderRadius: 6, cursor: "pointer",
                      color: "rgba(231,234,228,.6)",
                    }}
                  >
                    {showPw ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
                  </button>
                </div>
              </label>
            </div>
            <div className="hz-lg-item" style={{ ...delay(4), display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 13 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: 17, height: 17, accentColor: "var(--teal)", cursor: "pointer" }} />
                <span style={{ fontSize: 12.5, color: "rgba(231,234,228,.72)" }}>Remember me</span>
              </label>
              <span onClick={() => { window.location.hash = "#forgot"; }} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--gold)", cursor: "pointer" }}>Forgot password?</span>
            </div>
            {err && <div className="hz-lg-item" style={{ ...delay(4), marginTop: 12, fontSize: 12.5, color: "#f3b0a6", background: "rgba(226,75,74,.12)", border: "1px solid rgba(226,75,74,.3)", borderRadius: 10, padding: "9px 12px" }}>{err}</div>}
            <button onClick={onSignIn} disabled={busy} className="hz-lg-item lg-btn" style={{ ...delay(5), width: "100%", marginTop: 18, textAlign: "center", fontSize: 15, fontWeight: 800, color: "#fff", background: "var(--teal)", border: "none", borderRadius: 13, padding: 15, cursor: busy ? "default" : "pointer", fontFamily: "inherit", opacity: busy ? 0.7 : 1 }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </>
        ) : (
          <>
            <div className="hz-lg-item" style={{ ...delay(3), marginTop: 18 }}>
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") onVerify(); }} style={{ ...inputStyle, textAlign: "center", letterSpacing: ".4em", fontSize: 20 }} placeholder="••••••" />
            </div>
            {err && <div style={{ marginTop: 12, fontSize: 12.5, color: "#f3b0a6", background: "rgba(226,75,74,.12)", border: "1px solid rgba(226,75,74,.3)", borderRadius: 10, padding: "9px 12px" }}>{err}</div>}
            <button onClick={onVerify} disabled={busy} style={{ width: "100%", marginTop: 18, textAlign: "center", fontSize: 15, fontWeight: 800, color: "#fff", background: "var(--teal)", border: "none", borderRadius: 13, padding: 15, cursor: "pointer", fontFamily: "inherit", opacity: busy ? 0.7 : 1 }}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button onClick={() => { setChallenge(null); setCode(""); setErr(null); }} style={{ width: "100%", marginTop: 10, background: "none", border: "none", color: "rgba(231,234,228,.55)", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}>Back</button>
          </>
        )}

        <div className="hz-lg-item" style={{ ...delay(6), display: "flex", alignItems: "center", gap: 9, marginTop: 22 }}>
          <span style={{ flex: 1, height: 1, background: "rgba(231,234,228,.12)" }} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(231,234,228,.4)" }}>Houzs ERP</span>
          <span style={{ flex: 1, height: 1, background: "rgba(231,234,228,.12)" }} />
        </div>
        <div className="hz-lg-item" style={{ ...delay(6), textAlign: "center", fontSize: 11, color: "rgba(231,234,228,.45)", marginTop: 12, lineHeight: 1.5 }}>
          Your home screen is tailored to your position once you sign in.
        </div>
      </div>
    </div>
  );
}
