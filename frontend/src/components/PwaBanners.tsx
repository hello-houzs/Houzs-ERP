import { useEffect, useState } from "react";
import { Download, WifiOff, X } from "lucide-react";
import {
  onInstallAvailability,
  onOnline,
  promptInstall,
  isStandalone,
} from "../pwa";

/**
 * Two banner-style PWA UI bits:
 *   • Install prompt — surfaces when the browser fires
 *     beforeinstallprompt and the app isn't already installed.
 *     Dismissed state persists in localStorage so we don't nag.
 *   • Offline pill — appears when navigator goes offline; gives a
 *     clear "you are offline, reads come from cache, writes will
 *     fail" indicator.
 *
 * Mounted once at the app root, renders nothing the rest of the time.
 */

const DISMISS_KEY = "pwa:install:dismissed-at";
const NAG_AFTER_DAYS = 7;

export function PwaBanners() {
  const [canInstall, setCanInstall] = useState(false);
  const [online, setOnline] = useState(true);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => onInstallAvailability(setCanInstall), []);
  useEffect(() => onOnline(setOnline), []);

  // Decide install banner visibility:
  //   - browser said it's installable
  //   - app isn't already standalone
  //   - user hasn't dismissed in the last NAG_AFTER_DAYS days
  useEffect(() => {
    if (!canInstall || isStandalone()) {
      setShowInstall(false);
      return;
    }
    try {
      const v = localStorage.getItem(DISMISS_KEY);
      const dismissedAt = v ? parseInt(v, 10) : 0;
      const ageDays = (Date.now() - dismissedAt) / 86400000;
      setShowInstall(ageDays >= NAG_AFTER_DAYS);
    } catch {
      setShowInstall(true);
    }
  }, [canInstall]);

  function dismissInstall() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
    setShowInstall(false);
  }

  async function install() {
    const outcome = await promptInstall();
    if (outcome !== "unavailable") setShowInstall(false);
  }

  return (
    <>
      {!online && (
        <div
          className="fixed left-1/2 top-3 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-500/40 bg-amber-50 px-3 py-1.5 text-[11px] font-semibold text-amber-900 shadow-lg"
          role="status"
          aria-live="polite"
        >
          <WifiOff size={12} />
          You're offline — viewing cached data
        </div>
      )}

      {showInstall && (
        <div className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-md rounded-xl border border-accent/40 bg-surface px-4 py-3 shadow-slab sm:bottom-6">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Download size={16} />
            </div>
            <div className="flex-1">
              <div className="text-[12.5px] font-bold text-ink">Install Houzs ERP</div>
              <div className="mt-0.5 text-[11px] text-ink-secondary">
                Add to your home screen for quick access and offline-friendly use.
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={install}
                  className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-bold text-white hover:bg-primary-ink"
                >
                  Install
                </button>
                <button
                  onClick={dismissInstall}
                  className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary hover:text-ink"
                >
                  Not now
                </button>
              </div>
            </div>
            <button
              onClick={dismissInstall}
              aria-label="Dismiss"
              className="shrink-0 rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
