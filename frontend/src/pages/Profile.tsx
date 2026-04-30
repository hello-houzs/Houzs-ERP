import { useState, useEffect, useRef } from "react";
import { User as UserIcon, KeyRound, LogOut, Bell, Camera, Trash2 } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { Avatar } from "../components/Avatar";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatDate, relativeTime, cn } from "../lib/utils";
import {
  isBrowserPushEnabled,
  setBrowserPushEnabled,
} from "../components/BrowserPushSink";

/**
 * Self-service profile page for every authenticated staff user.
 *
 * Two concerns, two sections:
 *   1. Identity — display name (editable), email + role (read-only).
 *      Email/role changes are privileged; they live in the Team page.
 *   2. Password — change with current-password verification.
 *
 * Intentionally small and boring. Nothing role-specific, nothing
 * module-specific. Driver-focused fields live in DriverProfile.
 */
export function Profile() {
  const { user, reload, logout } = useAuth();
  const toast = useToast();

  const [name, setName] = useState(user?.name || "");
  const [savingName, setSavingName] = useState(false);
  const [picBusy, setPicBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setName(user?.name || "");
  }, [user?.name]);

  async function uploadPic(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be under 5 MB");
      return;
    }
    setPicBusy(true);
    try {
      await api.putBinary(
        `/api/users/me/profile-pic?name=${encodeURIComponent(file.name)}`,
        file,
        file.type,
      );
      await reload();
      toast.success("Profile picture updated");
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setPicBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removePic() {
    if (!user?.profile_pic_r2_key) return;
    setPicBusy(true);
    try {
      await api.del("/api/users/me/profile-pic");
      await reload();
      toast.success("Profile picture removed");
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setPicBusy(false);
    }
  }

  async function saveName() {
    if (!name.trim() || name === user?.name) return;
    setSavingName(true);
    try {
      await api.patch("/api/auth/me", { name: name.trim() });
      await reload();
      toast.success("Display name updated");
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSavingName(false);
    }
  }

  if (!user) {
    return null;
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        eyebrow="Account"
        title="Your Profile"
        description="Display name, password, and account info."
      />

      {/* ── Identity ─────────────────────────────── */}
      <section className="mb-6 rounded-md border border-border bg-surface p-6 shadow-stone">
        <div className="mb-5 flex items-center gap-4">
          <div className="relative shrink-0">
            <Avatar
              userId={user.id}
              hasImage={user.profile_pic_r2_key}
              name={user.name}
              email={user.email}
              size={72}
              ring
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={picBusy}
              className={cn(
                "absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border border-border bg-surface text-ink-secondary shadow-stone transition-colors hover:bg-accent hover:text-white",
                picBusy && "opacity-50",
              )}
              title="Change profile picture"
              aria-label="Change profile picture"
            >
              <Camera size={13} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPic(f);
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              Identity
            </h2>
            <div className="truncate font-display text-[18px] font-extrabold text-ink">
              {user.name || user.email}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
              <span className="inline-flex items-center gap-1">
                <UserIcon size={11} />
                {picBusy
                  ? "Uploading…"
                  : user.profile_pic_r2_key
                  ? "Click the camera to replace · max 5 MB"
                  : "Add a photo so teammates recognise you"}
              </span>
              {user.profile_pic_r2_key && !picBusy && (
                <button
                  type="button"
                  onClick={removePic}
                  className="inline-flex items-center gap-0.5 text-err transition-colors hover:underline"
                >
                  <Trash2 size={11} /> remove
                </button>
              )}
            </div>
          </div>
          <div className="self-start">
            <StatusDot
              variant={user.status === "active" ? "synced" : "neutral"}
              label={user.status}
            />
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Display Name
            </label>
            <div className="flex items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              <Button
                variant="primary"
                onClick={saveName}
                disabled={savingName || !name.trim() || name === user.name}
              >
                {savingName ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfoRow label="Email">
              <span className="font-mono text-[12px]">{user.email}</span>
            </InfoRow>
            <InfoRow label="Role">
              <span className="rounded bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent-ink">
                {user.role_name}
              </span>
            </InfoRow>
            {user.joined_at && (
              <InfoRow label="Joined">
                {formatDate(user.joined_at)}
                <span className="ml-1 text-ink-muted">
                  ({relativeTime(user.joined_at)})
                </span>
              </InfoRow>
            )}
            {user.last_login_at && (
              <InfoRow label="Last Login">
                {relativeTime(user.last_login_at)}
              </InfoRow>
            )}
          </div>
        </div>
      </section>

      {/* ── Notifications ────────────────────────── */}
      <NotificationsSection />

      {/* ── Change password ──────────────────────── */}
      <PasswordSection />

      {/* ── Footer — sign out ────────────────────── */}
      <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Session
            </h2>
            <div className="mt-1 text-[12px] text-ink-secondary">
              Sign out of this device. Other devices stay signed in.
            </div>
          </div>
          <Button
            variant="secondary"
            icon={<LogOut size={14} />}
            onClick={() => logout()}
          >
            Sign out
          </Button>
        </div>
      </section>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <div className="text-[13px]">{children}</div>
    </div>
  );
}

function NotificationsSection() {
  const toast = useToast();
  // Track the toggle + browser-level permission in local state so the UI
  // re-renders after permission prompts resolve.
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("notifications:browserPush") === "1";
    } catch {
      return false;
    }
  });
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported"
  );

  async function toggle() {
    if (permission === "unsupported") {
      toast.error("This browser doesn't support desktop notifications");
      return;
    }
    if (enabled) {
      // Turn OFF — just flip the preference. We don't revoke the
      // browser permission; that's the user's OS-level choice.
      setBrowserPushEnabled(false);
      setEnabled(false);
      toast.success("Browser notifications off");
      return;
    }
    // Turning ON — may need to prompt.
    if (permission === "default") {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        toast.error("Permission denied");
        return;
      }
    } else if (permission === "denied") {
      toast.error(
        "Notifications are blocked in your browser settings. Unblock them for this site and try again."
      );
      return;
    }
    setBrowserPushEnabled(true);
    setEnabled(true);
    toast.success("Browser notifications on");
    // Fire a hello banner so they see it worked.
    try {
      new Notification("Notifications enabled", {
        body: "You'll get a banner when there's new activity on your projects.",
        icon: "/logo-mark.png",
      });
    } catch {
      // no-op
    }
  }

  const supported = permission !== "unsupported";
  const active = enabled && permission === "granted";

  return (
    <section className="mb-6 rounded-md border border-border bg-surface p-6 shadow-stone">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Bell size={18} />
        </div>
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Notifications
          </h2>
          <div className="text-[12px] text-ink-secondary">
            The bell in the sidebar polls every 30s automatically. Turn on
            desktop notifications to get OS-level banners when new activity
            lands on your projects.
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg/40 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-ink">
            Browser notifications
          </div>
          <div className="mt-0.5 text-[11px] text-ink-muted">
            {!supported
              ? "Not supported in this browser."
              : permission === "denied"
              ? "Blocked in browser settings — unblock this site to enable."
              : active
              ? "On — banners fire when the tab is in the background."
              : "Off — you'll still see the in-app bell, just no OS banner."}
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={!supported}
          aria-pressed={active}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors",
            active
              ? "border-accent bg-accent"
              : "border-border bg-surface-dim",
            !supported && "opacity-40"
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
              active ? "translate-x-6" : "translate-x-1"
            )}
          />
        </button>
      </div>
    </section>
  );
}

// Silence the unused-import warning when the check doesn't branch.
void isBrowserPushEnabled;

function PasswordSection() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/auth/me/password", { current, next });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password updated — other sessions signed out");
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mb-6 rounded-md border border-border bg-surface p-6 shadow-stone">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
          <KeyRound size={18} />
        </div>
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Password
          </h2>
          <div className="text-[12px] text-ink-secondary">
            Change your password. Requires your current password. Other
            sessions will be signed out automatically.
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Current Password
          </label>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              New Password
            </label>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Confirm New Password
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
        </div>
        {error && (
          <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
            {error}
          </div>
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || !current || !next || !confirm}
          >
            {submitting ? "Updating…" : "Update password"}
          </Button>
        </div>
      </form>
    </section>
  );
}
