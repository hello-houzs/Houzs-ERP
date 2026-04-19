import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";

/**
 * Public reset-password screen — lives at /reset/:token. Bypasses the
 * authenticated app shell (main.tsx routes /reset/* here unprompted).
 * Fetches the token's metadata (email) to show "Reset for alice@…",
 * then submits a new password. On success, bounces back to /login.
 */

const baseUrl = (import.meta.env.VITE_API_URL as string) || "";

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

export function ResetPassword() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; email: string; name: string | null }
    | { kind: "error"; message: string }
    | { kind: "done" }
  >({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Verify the token up front so bad/expired links fail fast.
  useEffect(() => {
    if (!token) {
      setState({ kind: "error", message: "Missing token." });
      return;
    }
    fetch(`${baseUrl}/api/auth/reset/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.ok) {
          const d = (await r.json()) as { email: string; name: string | null };
          setState({ kind: "ready", ...d });
        } else {
          const d = await r.json().catch(() => ({ error: "Invalid link" }));
          setState({ kind: "error", message: d.error || "Invalid link" });
        }
      })
      .catch((e) => setState({ kind: "error", message: e?.message || "Network error" }));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPwd) {
      setSubmitError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`${baseUrl}/api/auth/reset/${encodeURIComponent(token!)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: "Failed" }));
        throw new Error(d.error || "Failed");
      }
      setState({ kind: "done" });
    } catch (e: any) {
      setSubmitError(e?.message || "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <AuthShell
        eyebrow="Password Reset"
        title="Checking your link…"
        subtitle="One moment."
      >
        <div className="h-6 w-full animate-pulse rounded bg-border" />
      </AuthShell>
    );
  }

  if (state.kind === "error") {
    return (
      <AuthShell
        eyebrow="Password Reset"
        title="Link unavailable"
        subtitle={state.message}
      >
        <Button variant="secondary" onClick={() => navigate("/")}>
          Go to login
        </Button>
      </AuthShell>
    );
  }

  if (state.kind === "done") {
    return (
      <AuthShell
        eyebrow="Password Reset"
        title="Password updated"
        subtitle="You can now sign in with your new password."
      >
        <Button onClick={() => navigate("/")}>Go to login</Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Password Reset"
      title={state.name ? `Hi ${state.name.split(" ")[0]},` : "Set a new password"}
      subtitle={`Choose a new password for ${state.email}. Minimum 8 characters.`}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            New password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="new-password"
            className={cn(
              "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            )}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Confirm password
          </label>
          <input
            type="password"
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
            autoComplete="new-password"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
        {submitError && (
          <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
            {submitError}
          </div>
        )}
        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? "Saving…" : "Update password"}
        </Button>
      </form>
    </AuthShell>
  );
}
