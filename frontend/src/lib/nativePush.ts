// ─────────────────────────────────────────────────────────────────────────
// nativePush.ts — APNs push for the Capacitor iOS shell.
//
// ── WHY A SECOND PATH RATHER THAN FIXING THE FIRST ──
// On the web, a notification is a LOCAL banner: the 30s poll in
// useNotifications finds a new row and BrowserPushSink calls new Notification().
// Nothing leaves the browser. That mechanism has two hard dependencies inside
// WKWebView, and both fail — the Notification constructor does not exist, and
// the poll stops the moment iOS suspends the app. A backgrounded iOS app can
// only be reached by APNs, which is a server push. So the native path is not a
// port of the web one; it is the opposite direction of travel, and the two
// share nothing but the opt-in flag.
//
// ── THE PERMISSION PROMPT IS THE ONE IRREVERSIBLE ACT HERE ──
// iOS shows the notification prompt ONCE. A user who declines cannot be asked
// again by the app — only by walking into Settings — so a prompt fired at cold
// start, before the app has shown anyone why it wants this, is how you get
// permanently denied. This module therefore never prompts on first launch: see
// shouldAutoPrompt() for the rule and its reasoning.
// ─────────────────────────────────────────────────────────────────────────

import { IS_NATIVE, nativePlatform } from './native';
import { api } from '../api/client';

/** Shared with the web path so one toggle governs both. */
const PUSH_PREF_KEY = 'notifications:browserPush';
/** Set once the OS prompt has been shown, so we never fire it twice. */
const ASKED_KEY = 'notifications:nativePush:asked';
/** Cold-start counter — see shouldAutoPrompt(). */
const LAUNCH_KEY = 'notifications:nativePush:launches';
/** Last token we successfully registered, so a no-op re-register is cheap. */
const LAST_TOKEN_KEY = 'notifications:nativePush:token';

/**
 * A tapped notification, normalised.
 *
 * `kind` and `id` come from the custom payload the backend attaches alongside
 * `aps` (see PushMessage.data in backend/src/services/apns.ts). Everything else
 * APNs delivered is kept in `raw` so the navigation layer can read fields this
 * module does not know about without a change here.
 */
export interface PushDeepLink {
  /** e.g. "project", "announcement", "so". Empty when the payload carried none. */
  kind: string;
  /** Record id as a string; the caller coerces. Empty when absent. */
  id: string;
  /** The full custom data object from the notification. */
  raw: Record<string, unknown>;
}

export type PushDeepLinkHandler = (link: PushDeepLink) => void;

let deepLinkHandler: PushDeepLinkHandler | null = null;
/**
 * Taps that arrived before a handler existed.
 *
 * A tap on a notification LAUNCHES the app from cold. Capacitor fires
 * pushNotificationActionPerformed during startup, which is reliably earlier
 * than the navigation layer mounting — so without this buffer the single most
 * important case, "user taps a notification to open the record", is the one
 * case that silently does nothing. Buffered links flush on registration.
 */
let pendingLinks: PushDeepLink[] = [];

/**
 * Register the navigation layer's handler for notification taps.
 *
 * Call once from the navigation/back-stack module. Any taps that arrived before
 * this call are delivered synchronously on registration, so a cold launch from
 * a notification lands on the right screen. Returns an unsubscribe function;
 * pass null to clear.
 *
 *   useEffect(() => setPushDeepLinkHandler((link) => {
 *     if (link.kind === 'project') navigateTo('project', Number(link.id));
 *   }), []);
 */
export function setPushDeepLinkHandler(handler: PushDeepLinkHandler | null): () => void {
  deepLinkHandler = handler;
  if (handler && pendingLinks.length > 0) {
    const queued = pendingLinks;
    pendingLinks = [];
    for (const link of queued) {
      try {
        handler(link);
      } catch {
        // A throwing handler must not poison the rest of the queue.
      }
    }
  }
  return () => {
    if (deepLinkHandler === handler) deepLinkHandler = null;
  };
}

/**
 * Called when a push arrives while the app is IN THE FOREGROUND. iOS does not
 * draw a banner in that case, so the app is responsible for surfacing it (the
 * notification bell already refreshes on its own poll). Optional — the shell
 * works without one.
 */
export type PushForegroundHandler = (msg: {
  title: string;
  body: string;
  link: PushDeepLink;
}) => void;

let foregroundHandler: PushForegroundHandler | null = null;

export function setPushForegroundHandler(handler: PushForegroundHandler | null): () => void {
  foregroundHandler = handler;
  return () => {
    if (foregroundHandler === handler) foregroundHandler = null;
  };
}

export function isNativePushSupported(): boolean {
  return IS_NATIVE;
}

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / quota. Losing these degrades to "prompt again next launch",
    // which is worse than ideal but not broken.
  }
}

/**
 * The plugin is loaded dynamically rather than imported at module scope.
 * @capacitor/push-notifications is in the web bundle too, and a static import
 * pulls its (unused on web) implementation into the main chunk for every
 * browser user of the ERP. Native-only cost belongs behind the native gate.
 */
async function loadPlugin() {
  const mod = await import('@capacitor/push-notifications');
  return mod.PushNotifications;
}

function toDeepLink(data: unknown): PushDeepLink {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return {
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    id: raw.id === undefined || raw.id === null ? '' : String(raw.id),
    raw,
  };
}

function dispatchDeepLink(link: PushDeepLink): void {
  if (deepLinkHandler) {
    try {
      deepLinkHandler(link);
      return;
    } catch {
      // fall through to buffering so the tap is not simply lost
    }
  }
  // Bounded: a user who taps many notifications before the nav layer mounts
  // wants the last one, not a replay of all of them.
  pendingLinks = [...pendingLinks, link].slice(-5);
}

let listenersAttached = false;
let tokenResolve: ((token: string) => void) | null = null;
let tokenReject: ((err: Error) => void) | null = null;

async function attachListeners(): Promise<void> {
  if (listenersAttached) return;
  listenersAttached = true;
  const PushNotifications = await loadPlugin();

  await PushNotifications.addListener('registration', (token) => {
    const value = token?.value ?? '';
    if (tokenResolve && value) {
      tokenResolve(value);
      tokenResolve = null;
      tokenReject = null;
    }
    // iOS can hand over a NEW token unprompted (restore from backup, some OS
    // upgrades). That arrives here with nobody awaiting it, and if it is not
    // sent onward the backend keeps pushing to a token that no longer routes.
    if (value && value !== readFlag(LAST_TOKEN_KEY)) {
      void sendTokenToBackend(value);
    }
  });

  await PushNotifications.addListener('registrationError', (err) => {
    if (tokenReject) {
      tokenReject(new Error(String((err as { error?: unknown })?.error ?? 'registration failed')));
      tokenResolve = null;
      tokenReject = null;
    }
  });

  await PushNotifications.addListener('pushNotificationReceived', (n) => {
    if (!foregroundHandler) return;
    try {
      foregroundHandler({
        title: n.title ?? '',
        body: n.body ?? '',
        link: toDeepLink(n.data),
      });
    } catch {
      // never let a UI handler break the plugin callback
    }
  });

  await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    dispatchDeepLink(toDeepLink(action?.notification?.data));
  });
}

async function sendTokenToBackend(token: string): Promise<boolean> {
  try {
    await api.post('/api/push/devices', {
      token,
      platform: nativePlatform() === 'android' ? 'android' : 'ios',
      // The dev/TestFlight build talks to APNs sandbox and the App Store build
      // to production; a token from one is rejected by the other. Vite's DEV
      // flag is the only signal available here, so it is what the backend gets.
      apns_env: import.meta.env.DEV ? 'sandbox' : 'production',
      app_version: (import.meta.env.VITE_APP_VERSION as string) || undefined,
    });
    writeFlag(LAST_TOKEN_KEY, token);
    return true;
  } catch {
    // Offline, or the session expired mid-flight. The next initNativePush()
    // re-registers, so this is a retry-later, not a failure to report.
    return false;
  }
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'denied' | 'registration_failed' | 'backend_failed' };

/**
 * Ask for permission (if not yet decided), register with APNs, and hand the
 * device token to the backend. Safe to call repeatedly.
 *
 * Call this from an explicit user action — a notifications toggle — or let
 * initNativePush() call it under the auto-prompt rule below.
 */
export async function enableNativePush(): Promise<EnableResult> {
  if (!IS_NATIVE) return { ok: false, reason: 'unsupported' };

  const PushNotifications = await loadPlugin();
  await attachListeners();

  let status = await PushNotifications.checkPermissions();
  if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
    writeFlag(ASKED_KEY, '1');
    status = await PushNotifications.requestPermissions();
  }
  if (status.receive !== 'granted') {
    writeFlag(PUSH_PREF_KEY, '0');
    return { ok: false, reason: 'denied' };
  }

  const token = await new Promise<string | null>((resolve) => {
    tokenResolve = (t) => resolve(t);
    tokenReject = () => resolve(null);
    // The APNs handshake is a network round-trip through the OS; without a
    // bound the caller's await never settles when the device is offline.
    setTimeout(() => {
      if (tokenResolve) {
        tokenResolve = null;
        tokenReject = null;
        resolve(null);
      }
    }, 15_000);
    void PushNotifications.register();
  });

  if (!token) return { ok: false, reason: 'registration_failed' };
  const sent = await sendTokenToBackend(token);
  if (!sent) return { ok: false, reason: 'backend_failed' };

  writeFlag(PUSH_PREF_KEY, '1');
  return { ok: true };
}

/**
 * Turn push off for this device: drop the row on the server so it stops being a
 * delivery target. The OS permission is left alone — that is the user's choice
 * to make in Settings, and revoking it here would be unrecoverable in-app.
 */
export async function disableNativePush(): Promise<void> {
  writeFlag(PUSH_PREF_KEY, '0');
  const token = readFlag(LAST_TOKEN_KEY);
  if (!token) return;
  try {
    await api.post('/api/push/devices/unregister', { token });
    writeFlag(LAST_TOKEN_KEY, '');
  } catch {
    // Best-effort. The token stays live until the next sign-in reassigns it or
    // APNs retires it; both are covered server-side.
  }
}

/**
 * Whether initNativePush() may fire the OS permission prompt on its own.
 *
 * The rule: NOT on the first launch. iOS gives one prompt ever, and a user who
 * has opened the app once has seen the notification bell and the activity feed
 * the push is about — asking then is a request they have context for, whereas
 * asking during the very first cold start is a modal in front of a stranger,
 * and a decline is permanent. The second-launch heuristic is deliberately crude
 * because the alternative, waiting for a perfect moment, is how apps end up
 * never asking at all.
 *
 * The counter is bumped by initNativePush(), so "launch" means "a signed-in
 * session that got as far as loading notifications", not merely a process start.
 */
function shouldAutoPrompt(): boolean {
  if (readFlag(ASKED_KEY) === '1') return false;
  return Number(readFlag(LAUNCH_KEY) ?? '0') >= 2;
}

/**
 * Wire up push for this session. Idempotent; call on mount once the user is
 * authenticated.
 *
 * Attaches the listeners unconditionally, so a tap that launched the app is
 * handled even when permission has not been granted yet. Then:
 *   - permission already granted -> re-register silently (tokens rotate),
 *   - permission still undecided and past the first launch -> prompt,
 *   - denied -> nothing; the OS will not let us ask again anyway.
 */
export async function initNativePush(): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await attachListeners();
    writeFlag(LAUNCH_KEY, String(Number(readFlag(LAUNCH_KEY) ?? '0') + 1));

    const PushNotifications = await loadPlugin();
    const status = await PushNotifications.checkPermissions();

    if (status.receive === 'granted') {
      await enableNativePush();
      return;
    }
    if (shouldAutoPrompt()) {
      await enableNativePush();
    }
  } catch {
    // The shell must boot with or without push.
  }
}
