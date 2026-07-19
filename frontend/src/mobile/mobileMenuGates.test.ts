import { describe, it, expect } from "vitest";
import { MOBILE_MENU_GROUPS, PROFILE_ORG_ITEMS, type MobileMenuItem } from "./MobileApp";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { CAPABILITY_KEYS } from "../auth/capabilities";

/**
 * EVERY mobile menu row must state its permission gate. This test is the reason
 * "I forgot to gate this" is now a CI failure instead of a silent public page.
 *
 * THE MECHANISM IT GUARDS. `MobileApp`'s `allowed(to)` ends with
 * `matches.length === 0 ? true` — a path with NO NAV_TABS entry is visible to
 * EVERY mobile user. That default has already produced the same bug twice: once
 * when the desktop /scm/drivers page was retired out from under the mobile row
 * that borrowed its gate, and again when the mobile-only /scm/helpers row was
 * added. Both were caught by a human reading the code. Neither was caught by a
 * compiler or a test, because an ungated row is perfectly valid TypeScript.
 *
 * WHY THE DEFAULT IS NOT SIMPLY FLIPPED TO DENY. Exactly one row legitimately
 * depends on the permissive default — `/activity-inbox` (see UNGATED_BY_DESIGN).
 * Flipping the default today would remove the Inbox row from the Profile screen
 * for every user in production. A screen that silently disappears is worse than
 * one that is over-shared: nobody reports it as a bug, they just quietly stop
 * using the feature. So the leak is CLOSED BY ENUMERATION instead — every row
 * must name its gate, and the ungated ones must be justified here in writing.
 *
 * WHEN THIS TEST FAILS, DO NOT ADD YOUR PATH TO UNGATED_BY_DESIGN TO GO GREEN.
 * That list is for rows with no permission to apply at all. If the screen reads
 * business data, it needs a real gate: give the row a `to` with a live NAV_TABS
 * entry, or a `gateVia` pointing at one that carries the same permission the
 * backend enforces on the screen's endpoint.
 */

/** Every `to` in the desktop nav tree, query stripped. This is the set of paths
 *  `allowed()` can actually find a gate for; anything outside it fails open. */
const navPaths = ((): Set<string> => {
  const out = new Set<string>();
  const walk = (t: NavTab) => {
    if (t.to != null) out.add(t.to.split("?")[0]);
    (t.children ?? []).forEach(walk);
  };
  NAV_TABS.forEach(walk);
  return out;
})();

/**
 * Rows that are ungated ON PURPOSE, each with the reason it has no permission to
 * apply. Adding to this list is a deliberate act that a reviewer must agree with
 * — it is not the way to silence a failure.
 *
 * TWO different mechanisms land a row here, and both must be justified:
 *   • no gate to borrow — no NAV_TABS entry, so `allowed()` fails open;
 *   • `alwaysShow` — which SKIPS `allowed()` even when a nav entry exists, and is
 *     therefore an ungating mechanism in its own right, not a mere hint.
 *
 * The third test below stops this list from rotting into a blanket exemption: an
 * entry that no longer names a row, or whose row has since become genuinely
 * gated, fails CI and must be removed.
 */
const UNGATED_BY_DESIGN = new Map<string, string>([
  [
    "/activity-inbox",
    "Mobile-only path (no App.tsx route, no NAV_TABS entry, so no desktop gate " +
      "to borrow). The project-activity feed is the phone's equivalent of the " +
      "desktop bell, which every signed-in user has, and it is audience-filtered " +
      "server-side by hooks/useNotifications — there is no page permission to apply.",
  ],
  [
    "/announcements",
    "Owner rule 2026-07: announcements are readable by EVERY active user. The " +
      "mobile screen reads /api/announcements/banner, which needs no permission " +
      "and is audience-filtered server-side (only notices addressed to this user). " +
      "The nav entry this row could borrow is announcements.read — the DESKTOP " +
      "admin list/composer permission — which is deliberately NOT the gate for " +
      "reading your own notices, so the row carries alwaysShow instead.",
  ],
]);

/** How a row states its gate, or null when it states none.
 *
 *  Order matters. `capability` and `alwaysShow` are checked BEFORE the nav
 *  lookup because both short-circuit `allowed()` at runtime — a row carrying
 *  `alwaysShow` is ungated whether or not a NAV_TABS entry happens to exist for
 *  its path, so crediting it with that entry's gate would be a false pass.
 *
 *  `capability` replaced `directorOnly`. It is the STRONGEST gate form a row can
 *  carry: the boolean is decided by the backend (services/capabilities.ts) and
 *  read verbatim, so unlike a nav-tab gate it cannot drift from the rule the
 *  endpoint enforces. A row is credited only when the key is one the frontend
 *  actually declares — a typo'd or retired key would otherwise read as a gate
 *  while `capability()` silently returned false for everyone, which is a
 *  fail-CLOSED bug but still a screen that vanished without anyone deciding it
 *  should. */
function gateOf(item: MobileMenuItem): string | null {
  const path = item.to.split("?")[0];
  if (item.capability) {
    return (CAPABILITY_KEYS as readonly string[]).includes(item.capability)
      ? `capability ${item.capability}`
      : null;
  }
  if (item.alwaysShow) return UNGATED_BY_DESIGN.has(path) ? "ungated by design (alwaysShow)" : null;
  if (item.gateVia) return navPaths.has(item.gateVia.split("?")[0]) ? `gateVia ${item.gateVia}` : null;
  if (navPaths.has(path)) return `NAV_TABS ${path}`;
  return UNGATED_BY_DESIGN.has(path) ? "ungated by design (no nav entry)" : null;
}

const allRows: MobileMenuItem[] = [
  ...MOBILE_MENU_GROUPS.flatMap((g) => g.items),
  ...PROFILE_ORG_ITEMS,
];

describe("mobile menu permission gates", () => {
  it("gives every menu and Profile row an explicit gate", () => {
    const ungated = allRows.filter((it) => gateOf(it) === null).map((it) => `${it.label} (${it.to})`);
    // Named in the failure so the next author sees WHICH row and WHAT to do,
    // rather than a bare `false !== true`.
    expect(
      ungated,
      ungated.length === 0
        ? ""
        : `These mobile rows have no permission gate. allowed() fails OPEN for a path ` +
          `with no NAV_TABS entry, so each of these is currently visible to EVERY mobile ` +
          `user regardless of position:\n  ${ungated.join("\n  ")}\n` +
          `Fix by pointing the row at a live NAV_TABS path, or adding gateVia to one that ` +
          `carries the same permission the backend enforces on the screen's endpoint. Do ` +
          `NOT add it to UNGATED_BY_DESIGN unless the screen genuinely has no permission ` +
          `to apply — read that list's comment first.`,
    ).toEqual([]);
  });

  it("keeps every gateVia pointing at a nav entry that still exists", () => {
    /* A gateVia is only a gate while its TARGET is live. If /scm/fleet were
       retired the way /scm/drivers was, the Drivers and Helpers rows would fail
       open again in silence — the same bug a third time, one level further in.
       gateOf() already returns null for a dead target, so the test above would
       catch it; this asserts it directly so the failure names the cause. */
    const dead = allRows
      .filter((it) => it.gateVia && !navPaths.has(it.gateVia.split("?")[0]))
      .map((it) => `${it.label} (${it.to}) -> gateVia ${it.gateVia}`);
    expect(
      dead,
      dead.length === 0 ? "" : `These rows borrow a gate from a NAV_TABS path that no longer exists, so they now fail OPEN:\n  ${dead.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the ungated-by-design list honest", () => {
    for (const [path, reason] of UNGATED_BY_DESIGN) {
      // A reason is the point of the list; an empty one is an exemption with no
      // argument behind it.
      expect(reason.length, `UNGATED_BY_DESIGN["${path}"] must say WHY it is ungated`).toBeGreaterThan(40);

      // Still a real row — a stale entry silently widens the exemption.
      const row = allRows.find((it) => it.to.split("?")[0] === path);
      expect(row, `UNGATED_BY_DESIGN names "${path}", which is no longer a mobile menu row — remove it`).toBeDefined();

      /* Still genuinely ungated by one of the two mechanisms. If a row loses its
         `alwaysShow` AND gains a nav entry, it is gated for real and the
         exemption must go rather than sit here quietly claiming otherwise. */
      expect(
        row!.alwaysShow === true || !navPaths.has(path),
        `"${path}" is now gated for real (it has a NAV_TABS entry and no alwaysShow) — remove it from UNGATED_BY_DESIGN and let the real gate apply`,
      ).toBe(true);
    }
  });

  it("pins the full set of ungated rows", () => {
    /* The list this PR was asked to produce, as an assertion rather than prose:
       a future change that ungates a second screen fails here, so the owner is
       told before it ships — not after someone notices a page they should not
       be able to see. Sorted so the assertion does not depend on list order. */
    expect([...UNGATED_BY_DESIGN.keys()].sort()).toEqual(["/activity-inbox", "/announcements"]);
  });
});
