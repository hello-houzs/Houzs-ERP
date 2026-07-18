import { useEffect, useRef } from "react";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications";
import { IS_NATIVE } from "../lib/native";
import { initNativePush } from "../lib/nativePush";
import {
  HOUZS_COMPANY_CODE,
  getBrandingCache,
  getBrandingCompanyCode,
  shortCompanyName,
} from "../lib/branding";

const PUSH_PREF_KEY = "notifications:browserPush";

export function isBrowserPushEnabled(): boolean {
  try {
    // Native shell delivers through APNs, not through this component. WKWebView
    // has no Notification constructor, so the check below would already be
    // false — this is the explicit statement of that, so the next reader does
    // not "fix" the missing constructor by polyfilling it.
    if (IS_NATIVE) return false;
    return (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      localStorage.getItem(PUSH_PREF_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function setBrowserPushEnabled(enabled: boolean) {
  try {
    localStorage.setItem(PUSH_PREF_KEY, enabled ? "1" : "0");
  } catch {
    // non-fatal
  }
}

/**
 * Invisible component mounted near the root. Watches the shared
 * notifications feed; when a new item appears and the user has
 * opted in to browser push, fires a native Notification() banner.
 * Seeds its seen-set from the current feed on first mount so you
 * don't get spammed with a backlog when first enabling the toggle.
 */
export function BrowserPushSink() {
  const { feed, lastTick } = useNotifications();
  const seenRef = useRef<Set<number>>(new Set());
  const primedRef = useRef(false);
  const nativeInitRef = useRef(false);

  // Native push is driven by the FIRST SUCCESSFUL POLL rather than by mount:
  // lastTick only advances once /api/notifications has answered, which proves
  // the session is live. Registering a device token against a session that is
  // about to 401 would file the token under the wrong user, and prompting for
  // OS permission before the app has loaded any data is the cold-start prompt
  // that gets an app permanently denied.
  useEffect(() => {
    if (!IS_NATIVE || nativeInitRef.current || lastTick === 0) return;
    nativeInitRef.current = true;
    void initNativePush();
  }, [lastTick]);

  useEffect(() => {
    // First tick after mount: treat everything we already have as
    // "seen" so existing items don't replay as OS banners. From the
    // next tick onward we only fire for genuinely-new rows.
    if (!primedRef.current && lastTick > 0) {
      primedRef.current = true;
      for (const item of feed) seenRef.current.add(item.id);
      return;
    }
    if (!isBrowserPushEnabled()) {
      // Still mark as seen so they don't all fire the moment the user
      // flips the toggle on with a large backlog.
      for (const item of feed) seenRef.current.add(item.id);
      return;
    }
    for (const item of feed) {
      if (seenRef.current.has(item.id)) continue;
      seenRef.current.add(item.id);
      fireNotification(item);
    }
  }, [lastTick, feed]);

  return null;
}

function fireNotification(a: NotificationItem) {
  try {
    // Per-company fallback title: HOUZS keeps the historic literal; another
    // active company reads "<short name> ERP" from the branding cache.
    const title =
      a.project_name ||
      (getBrandingCompanyCode() === HOUZS_COMPANY_CODE
        ? "Houzs ERP"
        : `${shortCompanyName(getBrandingCache().companyName)} ERP`);
    const body = summarise(a);
    const tag = `houzs-${a.project_id}-${a.id}`;
    const n = new Notification(title, {
      body,
      tag,
      icon: "/logo-mark.png",
    });
    n.onclick = () => {
      window.focus();
      // /projects/:id route is always the right landing.
      if (a.project_id) {
        window.location.href = `/projects/${a.project_id}`;
      }
      n.close();
    };
  } catch {
    // If the browser withdrew permission between checks, fail quiet.
  }
}

function summarise(a: NotificationItem): string {
  const who = a.user_name ? `${a.user_name}: ` : "";
  switch (a.action) {
    case "note":
      return `${who}${a.note || "…"}`;
    case "stage_change":
      return `${who}Stage ${a.from_value || "?"} → ${a.to_value || "?"}`;
    case "created":
      return `${who}Created the project`;
    case "checklist_status":
      return `${who}${a.note || "Updated checklist"}`;
    case "finance_edit":
      return `${who}Updated finance`;
    default:
      return `${who}${a.action}${a.note ? ` · ${a.note}` : ""}`;
  }
}
