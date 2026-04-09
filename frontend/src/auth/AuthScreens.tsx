import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";

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
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login(email, password);
    } catch (e: any) {
      setErr(e?.message?.includes("401") ? "Invalid email or password" : e?.message || "Login failed");
    } finally {
      setBusy(false);
    }
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
    if (password.length < 8) {
      setErr("Password must be at least 8 characters");
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
          <FieldLabel>Password (min 8 chars)</FieldLabel>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Choose a strong password"
            required
          />
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
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pull the token out of the URL hash (#invite=…) so an invite link
  // like https://app.example.com/#invite=ABC123 auto-fills it.
  useEffect(() => {
    const hash = window.location.hash;
    const m = hash.match(/invite=([^&]+)/);
    if (m) setToken(decodeURIComponent(m[1]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) {
      setErr("Password must be at least 8 characters");
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
      subtitle="Paste the invitation token you were given and set your password."
    >
      <form onSubmit={submit} className="space-y-4">
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
        <div>
          <FieldLabel>Your name</FieldLabel>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            required
          />
        </div>
        <div>
          <FieldLabel>Choose a password (min 8 chars)</FieldLabel>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
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

  // Not signed in → login (or invite acceptance via URL hash)
  if (!user) {
    if (window.location.hash.startsWith("#invite=")) {
      return <AcceptInviteScreen />;
    }
    return <LoginScreen />;
  }

  return <>{children}</>;
}
