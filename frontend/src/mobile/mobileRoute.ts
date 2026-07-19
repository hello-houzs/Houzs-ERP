/** Resolves the browser URL to a mobile destination.
 *
 *  WHY THIS FILE EXISTS. The mobile shell (MobileApp) is a `useState` screen
 *  machine, not a router: it mounts INSTEAD of the desktop `<Routes>` tree
 *  (auth/AuthScreens.tsx AuthGate) and, until this file, never read
 *  `window.location.pathname` at all. Its screen state simply initialised to
 *  the first bottom tab. So EVERY URL — /scm/purchase-orders,
 *  /scm/purchase-invoices, /scm/hr/settings, a typo, anything — rendered the
 *  Sales Orders list and fired the Sales Orders queries, with the page titled
 *  "Sales Orders". Not an error, not a blank: a DIFFERENT DOCUMENT TYPE shown
 *  confidently under another document's URL. The desktop tree's own
 *  `<Route path="*" element={<Forbidden kind="not-found" />} />` (App.tsx) was
 *  never reached, because the desktop tree never mounts on a phone.
 *
 *  This resolver answers one question and holds no opinions about permissions:
 *  "does this path name a destination the mobile app can open, and which one".
 *  The CALLER applies the gate, by passing only the destinations the signed-in
 *  user is actually allowed to see (MobileApp already computes exactly that
 *  list for its menu). A path that names a real destination the user may not
 *  open must resolve to `locked`, never to `home` — landing someone on the
 *  Orders list because they lack access is the same lie in a smaller form.
 */

/** Where a URL points, once resolved. */
export type MobileRoute =
  /** The app's own landing — the first bottom tab the user can open. */
  | { t: "home" }
  /** A path that IS one of the mobile bottom tabs. Only /profile today: the
   *  other tabs' paths (/scm/sales-orders, /assr) are menu destinations and
   *  resolve through `menu`. Without this, /profile would be told it "hasn't
   *  been built for phones" while the Profile tab sits right there. */
  | { t: "tab"; tab: "profile" }
  /** A destination the mobile menu can open. `to`/`label` are fed straight
   *  back into MobileApp's existing `openRoute`, so URL entry and menu entry
   *  can never drift into two different screens for one path. */
  | { t: "menu"; to: string; label: string }
  /** Deep link to one sales order — the mobile SO detail screen. */
  | { t: "so-detail"; docNo: string }
  /** A real destination that this user's position may not open. */
  | { t: "locked"; label: string }
  /** No mobile screen exists for this path. The honest dead end. */
  | { t: "desktop-only"; path: string };

export type MobileDestination = { to: string; label: string };

/** Segments after /scm/sales-orders/ that are NOT a document number. Each is a
 *  desktop-only creation flow or a destination of its own, so treating one as a
 *  docNo would deep-link to a sales order named "new". `maintenance` is a real
 *  mobile destination and is matched as an exact path before we get here. */
const SO_RESERVED_SEGMENTS = new Set(["new", "generate", "maintenance"]);

function normalise(pathname: string): string {
  const path = (pathname || "/").split("?")[0].split("#")[0];
  // Trailing slash is not a different page. Keep "/" itself intact.
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * @param pathname    `window.location.pathname` (query/hash tolerated).
 * @param visible     Destinations this user may open — MobileApp's already
 *                    permission-filtered menu + profile rows.
 * @param allKnown    Every destination the mobile app implements, gate ignored.
 *                    A path in here but not in `visible` is `locked`; a path in
 *                    neither is `desktop-only`.
 */
export function resolveMobileRoute(
  pathname: string,
  visible: readonly MobileDestination[],
  allKnown: readonly MobileDestination[],
): MobileRoute {
  const path = normalise(pathname);

  // The PWA start_url and every post-login redirect land here. Must stay the
  // plain landing, or the app would open on a "not available" screen.
  if (path === "/") return { t: "home" };

  // Ungated on purpose: the Profile tab has no permission gate in the shell
  // either (every signed-in user gets it).
  if (path === "/profile") return { t: "tab", tab: "profile" };

  const match = (list: readonly MobileDestination[]) =>
    list.find((d) => normalise(d.to.split("?")[0]) === path);

  const visibleHit = match(visible);
  if (visibleHit) return { t: "menu", to: visibleHit.to, label: visibleHit.label };

  const knownHit = match(allKnown);
  if (knownHit) return { t: "locked", label: knownHit.label };

  // Single-segment sales-order deep link → the mobile SO detail screen, which
  // takes exactly a docNo. Only ONE segment: /scm/sales-orders/new/guided is a
  // desktop creation wizard, not a document. Gated on the SO list being visible
  // to this user, since that is the permission the detail screen's data needs.
  const soDeep = /^\/scm\/sales-orders\/([^/]+)$/.exec(path);
  if (soDeep && !SO_RESERVED_SEGMENTS.has(soDeep[1])) {
    const canSo = visible.some((d) => normalise(d.to.split("?")[0]) === "/scm/sales-orders");
    if (!canSo) return { t: "locked", label: "Sales Orders" };
    return { t: "so-detail", docNo: decodeURIComponent(soDeep[1]) };
  }

  return { t: "desktop-only", path };
}
