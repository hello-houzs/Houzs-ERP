/**
 * PWA wiring — service worker registration + installable / online
 * state observable. Pure logic, no UI; the install banner reads
 * from this and renders itself.
 */

let deferredPrompt: any = null;
const installListeners = new Set<(canInstall: boolean) => void>();
const onlineListeners = new Set<(online: boolean) => void>();

export function registerPwa() {
  // DEV: never run a service worker. On localhost the SW caches the vite
  // module graph cache-first, so edits "don't show" after a refresh until the
  // SW + caches are cleared by hand. Tear down any SW a previous prod/PWA visit
  // left registered, and wipe its caches.
  if (import.meta.env.DEV) {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
    if (typeof caches !== "undefined") {
      caches
        .keys()
        .then((keys) => keys.forEach((k) => caches.delete(k)))
        .catch(() => {});
    }
  } else if ("serviceWorker" in navigator) {
    // PROD: register the SW (secure-context only; localhost is exempt but dev
    // is handled above).
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          // Best-effort update check on each load.
          reg.update().catch(() => {});
        })
        .catch((e) => {
          console.warn("[pwa] SW registration failed:", e);
        });
    });
  }

  // Capture the install prompt so we can replay it from a button.
  // Browsers fire `beforeinstallprompt` exactly once, so caching the
  // event is required if the user dismisses or delays.
  window.addEventListener("beforeinstallprompt", (e: any) => {
    e.preventDefault();
    deferredPrompt = e;
    notifyInstall(true);
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notifyInstall(false);
  });

  window.addEventListener("online", () => notifyOnline(true));
  window.addEventListener("offline", () => notifyOnline(false));
}

function notifyInstall(canInstall: boolean) {
  for (const fn of installListeners) fn(canInstall);
}
function notifyOnline(online: boolean) {
  for (const fn of onlineListeners) fn(online);
}

export function onInstallAvailability(fn: (canInstall: boolean) => void): () => void {
  installListeners.add(fn);
  // Fire synchronously with current state.
  fn(deferredPrompt != null);
  return () => installListeners.delete(fn);
}

export function onOnline(fn: (online: boolean) => void): () => void {
  onlineListeners.add(fn);
  fn(navigator.onLine);
  return () => onlineListeners.delete(fn);
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";
  try {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    notifyInstall(false);
    return choice.outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    return "unavailable";
  }
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS-specific
    (window.navigator as any).standalone === true
  );
}
