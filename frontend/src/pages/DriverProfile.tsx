import { useAuth } from "../auth/AuthContext";

export function DriverProfile() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div className="px-4 py-5">
      <div className="mb-5">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
          Profile
        </div>
        <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
          {user.name || user.email}
        </h1>
      </div>

      <div className="rounded-xl border border-border bg-surface p-4">
        <Field label="Email" value={user.email} />
        <Field label="Role" value={user.role_name} />
        <Field label="Status" value={user.status} />
      </div>

      <button
        onClick={() => logout()}
        className="mt-5 w-full rounded-md border border-err/60 bg-err/5 py-3 text-[13px] font-bold uppercase tracking-wide text-err"
      >
        Sign out
      </button>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-2 last:border-0">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
        {label}
      </span>
      <span className="text-[13px] font-medium text-ink">{value}</span>
    </div>
  );
}
