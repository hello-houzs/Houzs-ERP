/**
 * DORMANT PAGE COPY — the words both access-matrix editors say about a cell
 * that is settable, saves cleanly, and is read by nothing.
 *
 * The backend owns the FACT (`pageAccess.DORMANT_PAGE_KEYS` → the `dormant`
 * flag on GET /api/positions/pages and GET /api/roles/pages). This file owns
 * only the WORDS, because there are two editors and the owner ruled on the
 * behaviour rather than on a page:
 *   "不能留着了，然后「頁面灰色」点不到吗？最重要是我要它的 UI"  (2026-07-17)
 * — stop pretending it works, grey it out, and KEEP the row: the visual
 * inventory of what the system is meant to have is the point.
 *
 * WHY COPY AND NOT A COMPONENT. The two editors are not the same control and
 * cannot share one: Positions is the 4-level matrix (none/view/edit/full) on a
 * segmented button group; Roles is the legacy 3-level matrix
 * (none/partial/full) on radios, and `partial` is conditional on
 * `supportsPartial`. A shared row component would have to take both level
 * vocabularies and both control shapes — a false abstraction with two callers
 * that disagree on everything except this sentence. So the sentence is what is
 * shared, and it is shared because a setting that lies must not lie in two
 * different wordings: the admin who reads one editor and then the other is the
 * same person, and #709 shipped this text to prod already.
 */

/** Badge text on a dormant row. Lowercase — the editors uppercase it in CSS. */
export const DORMANT_TAG = "not wired";

/** Tooltip on the row, the badge, and every disabled control in it. */
export const DORMANT_TITLE =
  "This setting isn't wired to anything yet — nothing in the system reads it, so changing it would have no effect. Shown here because the page is part of the plan.";
