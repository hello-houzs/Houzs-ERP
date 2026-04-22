// /login — email + password form
// Redirects to ?from=xxx on success (or / by default).
// First-time logins get bounced to /change-password via ProtectedRoute.

import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Mail, Lock, Loader2, Eye, EyeOff } from "lucide-react";
import { login } from "@/lib/auth-store";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const from = params.get("from") ?? "/";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const r = await login(email.trim().toLowerCase(), password);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    nav(r.mustChangePassword ? "/change-password" : decodeURIComponent(from), { replace: true });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F3F4F6] p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow border border-[#E5E7EB] p-8">
        <div className="text-center mb-6">
          <h1 className="text-[20px] font-bold text-[#0A1F2E]">Houzs ERP</h1>
          <p className="text-[12px] text-gray-500 mt-1">Sign in to continue</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-gray-700 mb-1">Email</label>
            <div className="relative">
              <Mail className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-8 pl-8 pr-3 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
                placeholder="you@example.com"
                autoComplete="email"
                autoFocus
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-gray-700 mb-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
              <input
                type={showPw ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-8 pl-8 pr-8 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
                autoComplete="current-password"
              />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-2 text-gray-400 hover:text-gray-600" tabIndex={-1}>
                {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {err && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{err}</div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full h-9 rounded bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0d6660] disabled:opacity-60 inline-flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sign in
          </button>
        </form>

        <div className="mt-4 text-center">
          <Link to="/forgot-password" className="text-[11px] text-[#0F766E] hover:underline">
            Forgot password?
          </Link>
        </div>

        <div className="mt-6 text-center text-[10px] text-gray-400">
          Houzs Century Sdn Bhd
        </div>
      </div>
    </div>
  );
}
