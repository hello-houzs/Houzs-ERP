/**
 * Shared UI style tokens — single source of truth for all dashboard pages.
 * Import these instead of hardcoding classes in each page.
 */

// ─── Page layout ──────────────────────────────────────────────────────────────

/** Page title: h1 */
export const PAGE_TITLE = "text-2xl font-bold text-[#0A1F2E]";

/** Page subtitle / description */
export const PAGE_SUBTITLE = "text-sm text-gray-500 mt-1";

// ─── Cards ────────────────────────────────────────────────────────────────────

/** Card wrapper */
export const CARD = "rounded-lg border border-[#DDE5E5] bg-white";

/** Card section header */
export const CARD_HEADER =
  "px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] text-[11px] font-semibold uppercase tracking-wider text-[#0A1F2E]";

/** Card body */
export const CARD_BODY = "px-4 py-4";

// ─── Stats cards ──────────────────────────────────────────────────────────────

/** Stat label (small uppercase text) */
export const STAT_LABEL = "text-[9px] font-semibold uppercase tracking-wider text-gray-400";

/** Stat value (big number) */
export const STAT_VALUE = "text-xl font-bold mt-0.5 tabular-nums";

// ─── Filter bar ──────────────────────────────────────────────────────────────

/** Filter bar wrapper */
export const FILTER_BAR =
  "rounded-lg border border-[#DDE5E5] bg-white p-2.5 flex flex-wrap gap-2 items-center";

/** Search input inside filter bar */
export const SEARCH_INPUT =
  "w-full h-8 pl-8 pr-8 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-[#0A1F2E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]";

/** Filter select dropdown (with SVG chevron) */
export const FILTER_SELECT =
  "h-8 rounded-md border border-[#DDE5E5] bg-white pl-2.5 pr-7 text-[11px] font-semibold text-gray-600 appearance-none cursor-pointer hover:border-[#0F766E] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] bg-no-repeat bg-[right_0.5rem_center] bg-[length:10px] bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%236b7280%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22M6%209l6%206%206-6%22%2F%3E%3C%2Fsvg%3E')]";

// ─── Table / DataGrid ─────────────────────────────────────────────────────────

/** Table wrapper */
export const TABLE = "w-full text-[10px]";

/** Table header row */
export const TABLE_HEAD_ROW =
  "bg-[#DCE4EE] text-[9px] font-semibold uppercase tracking-wider text-[#0A1F2E] border-b border-gray-400";

/** Table header cell */
export const TABLE_HEAD_CELL = "text-left px-1.5 py-1 whitespace-nowrap border-r border-gray-300 last:border-r-0";

/** Table body divider */
export const TABLE_BODY = "divide-y divide-gray-200";

/** Table body cell */
export const TABLE_CELL = "px-1.5 py-0.5 whitespace-nowrap border-r border-gray-100 last:border-r-0";

/** Table row hover + cursor for double-click nav */
export const TABLE_ROW_INTERACTIVE = "hover:bg-[#F4F7F7] cursor-pointer transition-colors";

// ─── Buttons ──────────────────────────────────────────────────────────────────

/** Primary action button (teal bg) */
export const BTN_PRIMARY =
  "h-9 px-3.5 rounded-md bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0D6B63] inline-flex items-center gap-1.5";

/** Secondary / outline button */
export const BTN_SECONDARY =
  "h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1.5 transition";

/** Danger / destructive outline button */
export const BTN_DANGER =
  "h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-red-300 hover:text-red-600 inline-flex items-center gap-1";

// ─── Form fields ──────────────────────────────────────────────────────────────

/** Form field label */
export const FIELD_LABEL = "text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1";

/** Text input */
export const FIELD_INPUT =
  "w-full h-8 rounded-md border border-[#DDE5E5] px-2 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]";

/** Select input */
export const FIELD_SELECT =
  "w-full h-8 rounded-md border border-[#DDE5E5] px-2 text-[11px] bg-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]";

/** Textarea */
export const FIELD_TEXTAREA =
  "w-full rounded-md border border-[#DDE5E5] px-2 py-1.5 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] resize-y";

// ─── Dialogs ──────────────────────────────────────────────────────────────────

/** Dialog overlay */
export const DIALOG_OVERLAY = "fixed inset-0 z-50 flex items-center justify-center bg-black/40";

/** Dialog header */
export const DIALOG_HEADER =
  "px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between shrink-0";

/** Dialog footer */
export const DIALOG_FOOTER =
  "px-5 py-3 border-t border-[#DDE5E5] flex justify-end gap-2 shrink-0 bg-white";

// ─── Badge / Chip ─────────────────────────────────────────────────────────────

/** Small count badge */
export const COUNT_BADGE =
  "text-[11px] font-semibold bg-[#0F766E]/10 text-[#0F766E] px-2 py-0.5 rounded-full tabular-nums";

// ─── Colors ───────────────────────────────────────────────────────────────────

export const COLOR = {
  primary: "#0F766E",
  primaryHover: "#0D6B63",
  dark: "#0A1F2E",
  border: "#DDE5E5",
  bgSubtle: "#F4F7F7",
  bgPage: "#FAFBFB",
} as const;
