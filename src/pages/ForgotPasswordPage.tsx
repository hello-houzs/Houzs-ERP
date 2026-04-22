// /forgot-password — ask for email, server emails a reset link if account exists.
// Always shows the same success message so attackers can't enumerate.

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Mail, Loader2, CheckCircle2 } from "lucide-react";
import { authApi } from "@/lib/auth-api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await authApi.forgotPassword(email.trim().toLowerCase());
    setBusy(false);
    setSent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F3F4F6] p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow border border-[#E5E7EB] p-8">
        <h1 className="text-[18px] font-bold text-[#0A1F2E]">Forgot password</h1>
        <p className="text-[12px] text-gray-500 mt-1">
          We'll send a reset link to your email if an account exists.
        </p>

        {sent ? (
          <div className="mt-6 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500 mb-3" />
            <p className="text-[12px] text-gray-700">
              If <b>{email}</b> is registered, a reset link is on the way. It expires in 1 hour.
            </p>
            <Link to="/login" className="inline-block mt-5 text-[11px] text-[#0F766E] hover:underline">
              ← Back to login
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3 mt-5">
            <div>
              <label className="block text-[11px] font-semibold text-gray-700 mb-1">Email</label>
              <div className="relative">
                <Mail className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  className="w-full h-8 pl-8 pr-3 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
                  placeholder="you@example.com"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full h-9 rounded bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0d6660] disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Send reset link
            </button>
            <Link to="/login" className="block text-center text-[11px] text-[#0F766E] hover:underline">
              ← Back to login
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
