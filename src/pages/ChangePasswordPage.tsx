// /change-password — used both for forced first-time change and normal
// in-app password change.

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Loader2, CheckCircle2 } from "lucide-react";
import { authApi } from "@/lib/auth-api";
import { refreshCurrentUser, useAuthState } from "@/lib/auth-store";

function validate(pw: string): string | null {
  if (pw.length < 8) return "Must be at least 8 characters";
  if (!/[A-Z]/.test(pw)) return "Must contain at least 1 uppercase letter";
  if (!/[0-9]/.test(pw)) return "Must contain at least 1 digit";
  return null;
}

export default function ChangePasswordPage() {
  const { user } = useAuthState();
  const isForced = !!user?.mustChangePassword;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (next !== confirm) return setErr("Passwords do not match");
    const v = validate(next);
    if (v) return setErr(v);

    setBusy(true);
    const r = await authApi.changePassword(current, next);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    await refreshCurrentUser();
    setDone(true);
    setTimeout(() => nav("/", { replace: true }), 1200);
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F3F4F6] p-4">
        <div className="w-full max-w-md bg-white rounded-lg shadow border border-[#E5E7EB] p-8 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500 mb-3" />
          <h1 className="text-[16px] font-bold text-[#0A1F2E]">Password updated</h1>
          <p className="text-[12px] text-gray-500 mt-1">Redirecting…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F3F4F6] p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow border border-[#E5E7EB] p-8">
        <h1 className="text-[18px] font-bold text-[#0A1F2E]">{isForced ? "Set a new password" : "Change password"}</h1>
        <p className="text-[12px] text-gray-500 mt-1">
          {isForced
            ? "You must set a new password before using the system."
            : "Enter your current password, then choose a new one."}
        </p>

        <form onSubmit={submit} className="space-y-3 mt-5">
          <PasswordField
            label={isForced ? "Temporary password" : "Current password"}
            value={current}
            onChange={setCurrent}
            autoFocus
          />
          <PasswordField label="New password" value={next} onChange={setNext} />
          <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} />

          <p className="text-[10px] text-gray-500">
            At least 8 characters, including 1 uppercase letter and 1 digit.
          </p>

          {err && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{err}</div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full h-9 rounded bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0d6660] disabled:opacity-60 inline-flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Update password
          </button>
        </form>
      </div>
    </div>
  );
}

function PasswordField({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-gray-700 mb-1">{label}</label>
      <div className="relative">
        <Lock className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
        <input
          type="password"
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          className="w-full h-8 pl-8 pr-3 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
        />
      </div>
    </div>
  );
}
