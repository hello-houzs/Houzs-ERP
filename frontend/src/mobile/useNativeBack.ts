/**
 * Wires the platform's "go back" affordances into the shell's back stack.
 *
 * Android raises a hardware back event that does NOT go through history, so it
 * needs an explicit listener or it closes the app from any depth. iOS has no
 * hardware button at all and users reach for the left-edge swipe instead; a
 * WebView gives us nothing for that either, so the gesture is recognised here.
 * Note the shell does not animate the transition -- this restores the
 * navigation, not the native look of it.
 */

import { useEffect } from 'react';
import { IS_NATIVE, nativePlatform } from '../lib/native';

// Start well inside the bezel, and demand a mostly-horizontal travel, so the
// gesture cannot be confused with a vertical list scroll near the screen edge.
const EDGE_START_PX = 28;
const MIN_TRAVEL_PX = 72;
const MAX_DRIFT_PX = 48;

export function useNativeBack(onBack: () => void) {
  useEffect(() => {
    if (!IS_NATIVE) return;
    let disposed = false;
    let remove: (() => void) | undefined;

    import('@capacitor/app')
      .then(({ App }) => App.addListener('backButton', () => onBack()))
      .then((handle) => {
        if (disposed) void handle.remove();
        else remove = () => void handle.remove();
      })
      .catch(() => {});

    return () => {
      disposed = true;
      remove?.();
    };
  }, [onBack]);

  useEffect(() => {
    if (!IS_NATIVE || nativePlatform() !== 'ios') return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || t.clientX > EDGE_START_PX) {
        tracking = false;
        return;
      }
      tracking = true;
      startX = t.clientX;
      startY = t.clientY;
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      if (t.clientX - startX >= MIN_TRAVEL_PX && Math.abs(t.clientY - startY) <= MAX_DRIFT_PX) {
        onBack();
      }
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, [onBack]);
}
