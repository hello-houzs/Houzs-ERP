/**
 * Native-shell detection and the origins that stop being implicit once the app
 * is not served from its own web origin.
 *
 * In the browser the page origin IS the deployment (erp.houzscentury.com), so
 * relative /api/* works and window.location.origin is a URL a customer can
 * open. Inside the iOS shell the origin is capacitor://localhost, and BOTH of
 * those assumptions break silently: /api/* 404s, and a "share this link"
 * button produces capacitor://localhost/... that nobody can open. Everything
 * that depended on the origin being meaningful reads from here instead.
 */

import { Capacitor } from '@capacitor/core';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function nativePlatform(): 'ios' | 'android' | 'web' {
  const p = Capacitor.getPlatform();
  return p === 'ios' || p === 'android' ? p : 'web';
}

export const IS_NATIVE = isNativeApp();
export const IS_IOS_NATIVE = nativePlatform() === 'ios';

/**
 * Where the app is deployed on the public web. Used for links that LEAVE the
 * app: customer portal case links, staff invite links, password resets. On the
 * web this is the current origin (staging and prod each get their own, for
 * free). On native there is no meaningful origin, so it must be configured;
 * the fallback is prod because a wrong-but-real link beats capacitor://.
 */
export const PUBLIC_WEB_ORIGIN: string = (() => {
  const configured = (import.meta.env.VITE_PUBLIC_WEB_ORIGIN as string) || '';
  if (configured) return configured.replace(/\/+$/, '');
  if (IS_NATIVE) return 'https://erp.houzscentury.com';
  return typeof window !== 'undefined' ? window.location.origin : '';
})();
