import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";
import { api } from "../api/client";
import { PasswordStrengthMeter } from "../components/PasswordStrengthMeter";
import { validatePasswordStrength } from "../lib/passwordStrength";

/**
 * Shared shell for the unauthenticated screens — centered card on the
 * cream paper canvas, brass accent bar, brand voice.
 */
function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="paper-grain flex min-h-screen items-center justify-center px-4 py-12">
      <div className="relative w-full max-w-[420px] overflow-hidden rounded-lg border border-border bg-surface px-8 py-10 shadow-slab animate-rise">
        <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
        <div className="mb-1 flex items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <span className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            {eyebrow}
          </span>
        </div>
        <h1 className="font-display text-[24px] font-extrabold leading-tight tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-1.5 text-[12.5px] text-ink-secondary">{subtitle}</p>
        <div className="mt-6">{children}</div>
        <div className="mt-8 border-t border-border-subtle pt-4 text-[10px] uppercase tracking-brand text-ink-muted">
          Houzs Century · Operations
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      {children}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20",
        props.className
      )}
    />
  );
}

// ──────────────────────────────────────────────────────────
// Login
// ──────────────────────────────────────────────────────────
export function LoginScreen() {
  const { login, verifyTotpLogin } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Set once a password login returns a 2FA challenge — switches to the code step.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await login(email, password);
      if (res.kind === "totp") setChallenge(res.challenge);
    } catch (e: any) {
      setErr(e?.message?.includes("401") ? "Invalid email or password" : e?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await verifyTotpLogin(challenge!, code.trim());
    } catch (e: any) {
      setErr(
        e?.message?.includes("401")
          ? "That code didn't work — try the current code or a backup code."
          : e?.message || "Verification failed",
      );
    } finally {
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <AuthShell
        eyebrow="Two-Factor"
        title="Enter your code"
        subtitle="Open your authenticator app and enter the 6-digit code. You can also use a backup code."
      >
        <form onSubmit={submitCode} className="space-y-4">
          <div>
            <FieldLabel>Authentication code</FieldLabel>
            <TextInput
              inputMode="text"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
              autoFocus
            />
          </div>
          {err && <div className="text-[11px] text-err">{err}</div>}
          <Button variant="brass" className="w-full" disabled={busy}>
            {busy ? "Verifying…" : "Verify"}
          </Button>
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setChallenge(null);
                setCode("");
                setErr(null);
              }}
              className="text-[11px] text-ink-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Back to sign in
            </button>
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Sign In"
      title="Welcome back"
      subtitle="Enter your credentials to access the workspace."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel>Email</FieldLabel>
          <TextInput
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@houzscentury.com"
            required
            autoFocus
          />
        </div>
        <div>
          <FieldLabel>Password</FieldLabel>
          <TextInput
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
          <div className="mt-1.5 text-right">
            <a
              href="#forgot"
              className="text-[11px] text-ink-muted underline-offset-2 transition-colors hover:text-accent hover:underline"
            >
              Forgot password?
            </a>
          </div>
        </div>
        {err && <div className="text-[11px] text-err">{err}</div>}
        <Button variant="brass" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign In"}
        </Button>
      </form>
    </AuthShell>
  );
}

// ──────────────────────────────────────────────────────────
// Forgot password (self-service)
// ──────────────────────────────────────────────────────────
export function ForgotPasswordScreen() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/auth/forgot-password", {
        email: email.toLowerCase().trim(),
      });
    } catch {
      // Deliberately swallowed — the endpoint always answers ok and the
      // confirmation below stays generic (anti-enumeration).
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  if (sent) {
    return (
      <AuthShell
        eyebrow="Password Reset"
        title="Check your email"
        subtitle={`If an account exists for ${email || "that address"}, we've sent a reset link. It expires in 1 hour.`}
      >
        <a
          href="#"
          className="text-[12px] font-semibold text-accent underline-offset-2 hover:underline"
        >
          Back to sign in
        </a>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Password Reset"
      title="Forgot your password?"
      subtitle="Enter your account email and we'll send you a link to set a new one."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel>Email</FieldLabel>
          <TextInput
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@houzscentury.com"
            required
            autoFocus
          />
        </div>
        <Button variant="brass" className="w-full" disabled={busy}>
          {busy ? "Sending…" : "Send reset link"}
        </Button>
        <div className="text-center">
          <a
            href="#"
            className="text-[11px] text-ink-muted underline-offset-2 hover:text-accent hover:underline"
          >
            Back to sign in
          </a>
        </div>
      </form>
    </AuthShell>
  );
}

// ──────────────────────────────────────────────────────────
// Bootstrap (first owner)
// ──────────────────────────────────────────────────────────
export function BootstrapScreen() {
  const { bootstrap } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const strength = validatePasswordStrength(password, email);
    if (!strength.ok) {
      setErr(strength.error || "Password is too weak");
      return;
    }
    setBusy(true);
    try {
      await bootstrap(email, name, password);
    } catch (e: any) {
      setErr(e?.message || "Bootstrap failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="First Run"
      title="Create the first owner"
      subtitle="No accounts exist yet. The first user becomes the workspace owner with full access."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel>Your name</FieldLabel>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            required
            autoFocus
          />
        </div>
        <div>
          <FieldLabel>Email</FieldLabel>
          <TextInput
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@houzscentury.com"
            required
          />
        </div>
        <div>
          <FieldLabel>Password (min 12 chars)</FieldLabel>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Choose a strong password"
            required
          />
          <PasswordStrengthMeter password={password} email={email} />
        </div>
        {err && <div className="text-[11px] text-err">{err}</div>}
        <Button variant="brass" className="w-full" disabled={busy}>
          {busy ? "Creating…" : "Create Owner Account"}
        </Button>
      </form>
    </AuthShell>
  );
}

// ──────────────────────────────────────────────────────────
// Accept invitation
// ──────────────────────────────────────────────────────────
export function AcceptInviteScreen() {
  const { acceptInvite } = useAuth();
  const baseUrl =
    (import.meta.env.VITE_API_URL as string) ||
    "https://autocount-sync-api.houzs-erp.workers.dev";
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Invitation metadata (email + role/position + preset name) fetched
  // from the preflight endpoint so the invitee sees who they're joining
  // as instead of pasting an opaque token.
  const [meta, setMeta] = useState<{ email: string; role_name: string } | null>(
    null
  );

  // Pull the token out of the URL hash (#invite=…), then preflight it so
  // we can pre-fill the name/email and show the role they're invited as.
  useEffect(() => {
    const m = window.location.hash.match(/invite=([^&]+)/);
    if (!m) return;
    const t = decodeURIComponent(m[1]);
    setToken(t);
    fetch(`${baseUrl}/api/auth/invite/${encodeURIComponent(t)}`)
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json()) as {
          email: string;
          name: string | null;
          role_name: string;
        };
        setMeta({ email: d.email, role_name: d.role_name });
        if (d.name) setName(d.name);
      })
      .catch(() => {
        /* fall back to the manual token form below */
      });
  }, [baseUrl]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const strength = validatePasswordStrength(password);
    if (!strength.ok) {
      setErr(strength.error || "Password is too weak");
      return;
    }
    setBusy(true);
    try {
      await acceptInvite(token, name, password);
    } catch (e: any) {
      setErr(e?.message || "Could not accept invitation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Join Workspace"
      title="Accept your invitation"
      subtitle={
        meta
          ? `You've been invited to join as ${meta.role_name}. Set your name and password to continue.`
          : "Paste the invitation token you were given and set your password."
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {meta ? (
          <div className="rounded-md border border-border bg-bg/60 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Email
            </div>
            <div className="text-[13px] font-semibold text-ink">
              {meta.email}
            </div>
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent-ink">
              {meta.role_name}
            </div>
          </div>
        ) : (
          <div>
            <FieldLabel>Invitation Token</FieldLabel>
            <TextInput
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste your token"
              className="font-mono text-[11px]"
              required
              autoFocus
            />
          </div>
        )}
        <div>
          <FieldLabel>Your name</FieldLabel>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            required
            autoFocus={!!meta}
          />
        </div>
        <div>
          <FieldLabel>Choose a password (min 12 chars)</FieldLabel>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
          <PasswordStrengthMeter password={password} />
        </div>
        {err && <div className="text-[11px] text-err">{err}</div>}
        <Button variant="brass" className="w-full" disabled={busy}>
          {busy ? "Joining…" : "Join Workspace"}
        </Button>
      </form>
    </AuthShell>
  );
}

// ──────────────────────────────────────────────────────────
// Gate — picks the right screen based on auth state
// ──────────────────────────────────────────────────────────
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading, hasUsers } = useAuth();

  // Track the hash so in-page links (#forgot, back-to-login) re-render
  // the gate without a full navigation. #invite= arrives as a fresh
  // page load, but gets the same reactivity for free.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Initial loading state — neutral splash
  if (loading) {
    return (
      <div className="paper-grain flex min-h-screen items-center justify-center">
        <div className="font-display text-[12px] uppercase tracking-brand text-ink-muted">
          Houzs Century · Loading
        </div>
      </div>
    );
  }

  // No users in the database → first-owner bootstrap
  if (hasUsers === false) {
    return <BootstrapScreen />;
  }

  // Not signed in → login (or invite acceptance / forgot password via
  // URL hash)
  if (!user) {
    if (hash.startsWith("#invite=")) {
      return <AcceptInviteScreen />;
    }
    if (hash === "#forgot") {
      return <ForgotPasswordScreen />;
    }
    return <LoginScreen />;
  }

  return <>{children}</>;
}
