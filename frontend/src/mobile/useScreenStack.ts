/**
 * A back stack for the mobile shell.
 *
 * The shell navigates with a single `useState<Screen>` and no router, which is
 * fine while the only way back is an on-screen chevron. It stops being fine
 * inside a native shell: Android's hardware back and iOS's edge swipe have
 * nothing to act on, so back exits the app from six screens deep. The browser
 * back button had the same problem on the installed PWA.
 *
 * Rather than rewrite ~58 navigation call sites, this keeps their signature.
 * `push` IS the old setScreen. What changes is that the previous screen is
 * remembered, and that a push naming the screen directly beneath the top is
 * recognised as a return and pops instead of growing the stack -- the shell
 * already expresses "go back to the list" that way (module-form's onBack names
 * the module screen), and those must not stack up as new entries.
 *
 * History integration is one-directional on purpose: every pop goes out
 * through history.back(), and only the resulting popstate mutates the stack.
 * Driving both ends independently double-pops. Entries are pushed at the
 * CURRENT href so a BrowserRouter mounted above the shell sees no path change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Deep enough for any real path through the shell; bounded so a navigation
// loop cannot grow the array without limit.
const MAX_DEPTH = 25;

const HISTORY_MARKER = 'hz-m-stack';

export type ScreenStack<S> = {
  screen: S;
  depth: number;
  canGoBack: boolean;
  push: (next: S) => void;
  /** Pop one level. No-op at the root -- the caller decides what root-back means. */
  pop: () => void;
  /** Drop everything above the root. For tab switches. */
  resetToRoot: () => void;
};

export function useScreenStack<S>(root: S, keyOf: (s: S) => string): ScreenStack<S> {
  const [stack, setStack] = useState<S[]>([root]);

  // popstate needs the live depth, but re-subscribing the listener on every
  // navigation would drop events mid-transition.
  const depthRef = useRef(1);
  depthRef.current = stack.length;

  const push = useCallback(
    (next: S) => {
      setStack((prev) => {
        const top = prev[prev.length - 1];
        if (keyOf(next) === keyOf(top)) return prev;

        const beneath = prev.length >= 2 ? prev[prev.length - 2] : undefined;
        if (beneath !== undefined && keyOf(next) === keyOf(beneath)) {
          // A return, not a new destination. Let history drive it so the
          // native gesture and this path converge on one code path.
          try {
            window.history.back();
          } catch {}
          return prev;
        }

        try {
          window.history.pushState({ [HISTORY_MARKER]: prev.length + 1 }, '', window.location.href);
        } catch {}

        const grown = [...prev, next];
        return grown.length > MAX_DEPTH ? grown.slice(grown.length - MAX_DEPTH) : grown;
      });
    },
    [keyOf],
  );

  const pop = useCallback(() => {
    if (depthRef.current <= 1) return;
    try {
      window.history.back();
    } catch {
      setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    }
  }, []);

  const resetToRoot = useCallback(() => {
    const over = depthRef.current - 1;
    if (over <= 0) return;
    try {
      window.history.go(-over);
    } catch {
      setStack((prev) => prev.slice(0, 1));
    }
  }, []);

  useEffect(() => {
    const onPop = () => {
      setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Memoised: consumers put this in effect deps (the native back listener), and
  // a fresh object each render would re-subscribe on every keystroke.
  const screen = stack[stack.length - 1];
  return useMemo(
    () => ({
      screen,
      depth: stack.length,
      canGoBack: stack.length > 1,
      push,
      pop,
      resetToRoot,
    }),
    [screen, stack.length, push, pop, resetToRoot],
  );
}
