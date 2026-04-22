// /reset-password?token=xxx — user lands here from the email link.
// Enter new password + confirm → server consumes token → redirect to login.

import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Lock, Loader2, CheckCircle2 } from "lucide-react";
import { authApi } from "@/lib/auth-api";

function validate(pw: string): string | null {
  if (pw.length < 8) return "Must be at least 8 characters";
  if (!/[A-Z]/.test(pw)) return "Must contain at least 1 uppercase letter";
  if (!/[0-9]/.test(pw)) return "Must contain at least 1 digit";
  return null;
}

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!token) return setErr("Missing reset token — use the link from your email");
    if (next !== confirm) return setErr("Passwords do not match");
    const v = validate(next);
    if (v) return setErr(v);

    setBusy(true);
    const r = await authApi.resetPassword(token, next);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setDone(true);
    setTimeout(() => nav("/login", { replace: true }), 1500);
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F3F4F6] p-4">
        <div className="w-full max-w-md bg-white rounded-lg shadow border border-[#E5E7EB] p-8 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500 mb-3" />
          <h1 className="text-[16px] font-bold text-[#0A1F2E]">Password reset</h1>
          <p className="text-[12px] text-gray-500 mt-1">Redirecting to login…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F3F4F6] p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow border border-[#E5E7EB] p-8">
        <h1 className="text-[18px] font-bold text-[#0A1F2E]">Reset password</h1>
        <p className="text-[12px] text-gray-500 mt-1">Choose a new password for your account.</p>

        <form onSubmit={submit} className="space-y-3 mt-5">
          <div>
            <label className="block text-[11px] font-semibold text-gray-700 mb-1">New password</label>
            <div className="relative">
              <Lock className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
              <input type="password" required value={next} onChange={(e) => setNext(e.target.value)} autoFocus
                className="w-full h-8 pl-8 pr-3 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-gray-700 mb-1">Confirm new password</label>
            <div className="relative">
              <Lock className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
              <input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)}
                className="w-full h-8 pl-8 pr-3 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]" />
            </div>
          </div>
          <p className="text-[10px] text-gray-500">
            At least 8 characters, including 1 uppercase letter and 1 digit.
          </p>
          {err && (<div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{err}</div>)}
          <button type="submit" disabled={busy}
            className="w-full h-9 rounded bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0d6660] disabled:opacity-60 inline-flex items-center justify-center gap-2">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Set new password
          </button>
          <Link to="/login" className="block text-center text-[11px] text-[#0F766E] hover:underline">← Back to login</Link>
        </form>
      </div>
    </div>
  );
}
