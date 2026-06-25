import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Download,
  Upload,
  Search,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  ChevronRight,
  LayoutList,
  Table as TableIcon,
  Pin,
  PinOff,
  EyeOff,
  MoveHorizontal,
} from "lucide-react";
import { cn } from "../lib/utils";
import { ResetFiltersButton } from "./ResetFiltersButton";
import { TableSkeleton } from "./Skeleton";
import { ColumnsPanel, ColumnsPanelButton } from "./ColumnsPanel";
import { UdfCell } from "./UdfCell";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUdf, type UseUdfResult } from "../hooks/useUdf";
import { downloadCSV, toCSV, type CSVColumn } from "../lib/csv";

export interface Column<T> {
  key: string;
  label: string;
  width?: string;
  align?: "left" | "right" | "center";
  className?: string;
  /** Render the cell. */
  render: (row: T) => ReactNode;
  /** Optional custom header content (e.g. a select-all checkbox). When set,
   *  it replaces the label + sort affordance for this column. */
  renderHeader?: () => ReactNode;
  /** Provide a raw value for CSV export and client-side sorting. Columns
   *  without this are skipped during export and can't be sorted. */
  getValue?: (row: T) => string | number | boolean | null | undefined;
  /** If true, the column is excluded from the column chooser AND pinned
   *  to the front of the render order (can't be reordered past). */
  alwaysVisible?: boolean;
  /** Opt-out of sort for columns that have getValue but aren't meaningfully
   *  sortable (e.g. a selection checkbox column). */
  disableSort?: boolean;
  /**
   * Hide on first load even though the column exists. The user can still
   * reveal it from the Columns panel (and that override is persisted).
   * Useful for "extended" columns that come from a wide upstream payload
   * — show a sane default subset, let power users opt-in to the rest.
   */
  defaultHidden?: boolean;
}

interface Props<T> {
  /** Stable identifier used for persisting column visibility, order, sort,
   *  and density per page (localStorage). */
  tableId?: string;
  columns: Column<T>[];
  rows: T[] | null;
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  onRowClick?: (row: T) => void;
  getRowKey: (row: T) => string | number;
  getRowClassName?: (row: T) => string | undefined;
  /** Filename stem for CSV export, e.g. "orders". A date suffix is appended automatically. */
  exportName?: string;
  /** If provided, an Import button is shown that calls this with the parsed File. */
  onImport?: (file: File) => void;
  /** Optional eyebrow rendered next to the row count. */
  caption?: string;
  /**
   * Backend table identifier for user-defined fields. When set, the
   * Columns panel grows a "Custom Fields" section (add/delete), UDF
   * columns render alongside the static ones, and cells are editable
   * inline. UDFs are stored in worker D1 and never synced to AutoCount.
   */
  udfTable?: string;
  /** Friendly label used in the Custom Fields section heading. */
  udfTableLabel?: string;
  /**
   * When provided, renders a search input on the left side of the table
   * toolbar. The page is responsible for resetting pagination on change.
   */
  search?: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
  };
  /**
   * When provided, renders a "Reset" button next to the search input
   * that is visible only while `filtersActive` is true. The page owns
   * the meaning of "active" and the actual clear logic (URL params,
   * sticky storage, pagination).
   */
  resetFilters?: {
    active: boolean;
    onReset: () => void;
    label?: string;
  };
  /**
   * Server-side sort. When true, clicking a header doesn't sort the
   * visible rows in-memory — instead the parent gets the new sort via
   * `onSortChange` and is expected to re-query with `sort_by` /
   * `sort_dir` so the ordering applies across the entire dataset
   * (not just the current page).
   */
  serverSort?: boolean;
  onSortChange?: (sort: { key: string; dir: "asc" | "desc" } | null) => void;
  /**
   * Customise the mobile (<sm) card layout. When omitted, the mobile
   * branch falls back to "first visible column = title; rest as label /
   * value rows", which is right for most heterogeneous tables. Some
   * dense list views (e.g. Trips Queue) want fewer cells laid out as a
   * value-only grid — that's what this opts into.
   */
  mobileCard?: {
    /** Column key used as the card title. Defaults to first visible column. */
    primary?: string;
    /** Ordered keys to show below the title. Defaults to remaining visible columns. */
    cells?: string[];
    /** "stack" (today) or "grid-2" — two equal columns, value-only. */
    layout?: "stack" | "grid-2";
    /** Hide the `<dt>` labels even in "stack" layout. Default false. */
    hideLabels?: boolean;
  };
  /**
   * Opt-in drill-down (2990 DataGrid parity). When set, a 32px chevron
   * column is prepended; clicking the chevron (or the chevron cell)
   * toggles an inline expanded sub-`<tr>` below the row that spans the
   * full width and renders `expandable.render(row)`. Expanded ids live in
   * a transient Set (not persisted — drill-downs reset on reload). Absent
   * (default) = no chevron column, layout byte-identical to before.
   */
  expandable?: {
    /** Render the expanded sub-row body. */
    render: (row: T) => ReactNode;
    /** Stable id for expansion state. Defaults to `getRowKey`. */
    rowKey?: (row: T) => string;
  };
  /**
   * Opt-in row right-click menu (2990 DataGrid parity). Receives the row
   * and returns the items to show. Returning an empty array suppresses
   * the menu for that row (the native menu is still suppressed once the
   * prop is present). A `divider: true` item renders a rule; `danger`
   * tints the item with the error token. Absent (default) = the browser's
   * native context menu, unchanged.
   */
  contextMenu?: (
    row: T
  ) => Array<{
    label: string;
    onClick: () => void;
    danger?: boolean;
    divider?: boolean;
  }>;
  /**
   * Opt-in single-level group-by (2990 DataGrid parity). Rows are bucketed
   * by `groupBy.key` (a column key; the column must expose `getValue` so we
   * have a stable group value). Each bucket gets a collapsible header row
   * with a count; collapse state is persisted per table. Grouping applies
   * to the desktop table only — the mobile card branch is untouched.
   * Absent (default) = flat rows, render path byte-identical to before.
   */
  groupBy?: {
    /** Column key to group on. Must match a column with `getValue`. */
    key: string;
    /** Pretty-print a raw group value for the header. */
    label?: (val: string) => string;
  };
}

type SortDir = "asc" | "desc";
interface SortState {
  key: string;
  dir: SortDir;
}

// Resize / pin tuning. MIN_COL_WIDTH is the floor a drag can shrink a
// column to. DEFAULT_COL_WIDTH is the assumed width when computing a
// pinned column's sticky-left offset and the column has no user width and
// no px-parseable `width` default (e.g. a "%" width or none at all).
const MIN_COL_WIDTH = 64;
const DEFAULT_COL_WIDTH = 160;

export function DataTable<T>({
  tableId,
  columns,
  rows,
  loading,
  error,
  emptyLabel = "No data",
  onRowClick,
  getRowKey,
  getRowClassName,
  exportName,
  onImport,
  caption,
  udfTable,
  udfTableLabel,
  search,
  resetFilters,
  serverSort,
  onSortChange,
  mobileCard,
  expandable,
  contextMenu,
  groupBy,
}: Props<T>) {
  const idKey = tableId || "_";
  const [hiddenList, setHiddenList] = useLocalStorage<string[]>(`dt:hidden:${idKey}`, []);
  // `shownList` lets the user opt-IN to a column that's defaultHidden=true.
  // We need a separate set (rather than relying on hiddenList alone) so a
  // defaultHidden column stays hidden until the user explicitly enables it.
  const [shownList, setShownList] = useLocalStorage<string[]>(`dt:shown:${idKey}`, []);
  const [order, setOrder] = useLocalStorage<string[]>(`dt:order:${idKey}`, []);
  const [sort, setSort] = useLocalStorage<SortState | null>(`dt:sort:${idKey}`, null);
  // Mobile-only view preference. "cards" renders the stacked cards
  // (default for `<sm`); "table" forces the desktop table with a
  // horizontal scroll. Persisted per-table so each list page
  // remembers the user's choice.
  const [mobileView, setMobileView] = useLocalStorage<"cards" | "table">(
    `dt:mview:${idKey}`,
    "cards",
  );
  // Per-column user widths (px). Overrides the column's `width` default.
  // Keyed by column key; absent = use the column default. Desktop-only —
  // the mobile card branch ignores widths entirely.
  const [widths, setWidths] = useLocalStorage<Record<string, number>>(
    `dt:widths:${idKey}`,
    {},
  );
  // Pinned (frozen-left) column keys. Pinned columns render at the front
  // (after any alwaysVisible columns) and stick during horizontal scroll.
  const [pinned, setPinned] = useLocalStorage<string[]>(`dt:pinned:${idKey}`, []);
  const [chooserOpen, setChooserOpen] = useState(false);
  const userHidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const userShown = useMemo(() => new Set(shownList), [shownList]);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  // Header right-click menu — transient (not persisted). Holds the anchor
  // point and the column it was opened on. null = closed.
  const [headerMenu, setHeaderMenu] = useState<{
    x: number;
    y: number;
    colKey: string;
  } | null>(null);

  // Expanded drill-down rows (opt-in `expandable`). Transient — a Set of
  // expansion ids so the chevron toggle is O(1) and reloads start collapsed.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const expansionId = useCallback(
    (row: T) =>
      expandable?.rowKey ? expandable.rowKey(row) : String(getRowKey(row)),
    [expandable, getRowKey]
  );
  const toggleExpand = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Row right-click menu (opt-in `contextMenu`). Transient — anchor point
  // plus the items resolved at open time. null = closed.
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    items: Array<{
      label: string;
      onClick: () => void;
      danger?: boolean;
      divider?: boolean;
    }>;
  } | null>(null);

  // Collapsed group keys (opt-in `groupBy`). Persisted per table so a
  // user's collapse choices survive reloads, mirroring the other dt:* prefs.
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage<string[]>(
    `dt:groups:${idKey}`,
    []
  );
  const collapsedGroupSet = useMemo(
    () => new Set(collapsedGroups),
    [collapsedGroups]
  );
  const toggleGroup = useCallback(
    (val: string) => {
      setCollapsedGroups((prev) =>
        prev.includes(val) ? prev.filter((k) => k !== val) : [...prev, val]
      );
    },
    [setCollapsedGroups]
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── UDF integration ─────────────────────────────────────
  const udf: UseUdfResult = useUdf(udfTable);

  /**
   * Build synthetic Column<T> entries from the UDF field definitions so they
   * slot into the same rendering pipeline as the static columns. Cells edit
   * via UdfCell, which writes through the hook's setValue.
   */
  const udfColumns: Column<T>[] = useMemo(() => {
    return udf.fields.map<Column<T>>((field) => ({
      key: `udf:${field.key}`,
      label: field.label,
      render: (row: T) => {
        const rowKey = String(getRowKey(row));
        const value = udf.values[rowKey]?.[field.key] ?? null;
        return (
          <UdfCell
            field={field}
            value={value}
            onSave={(next) => udf.setValue(rowKey, field.key, next)}
          />
        );
      },
      getValue: (row: T) => {
        const rowKey = String(getRowKey(row));
        return udf.values[rowKey]?.[field.key] ?? "";
      },
    }));
  }, [udf.fields, udf.values, getRowKey, udf.setValue]);

  // Unordered universe of columns (static + UDF).
  const rawColumns = useMemo(() => [...columns, ...udfColumns], [columns, udfColumns]);

  // Apply persisted order. alwaysVisible columns are pinned at the front
  // in their definition order (not reorderable); everything else follows
  // the user's order, then anything new that isn't yet in the stored
  // order gets appended (so new columns appear at the end without the
  // user losing their arrangement).
  const allColumns = useMemo(() => {
    const alwaysFirst = rawColumns.filter((c) => c.alwaysVisible);
    const movable = rawColumns.filter((c) => !c.alwaysVisible);
    if (!order || order.length === 0) return [...alwaysFirst, ...movable];
    const byKey = new Map(movable.map((c) => [c.key, c]));
    const ordered: Column<T>[] = [];
    for (const k of order) {
      const col = byKey.get(k);
      if (col) {
        ordered.push(col);
        byKey.delete(k);
      }
    }
    // Any movable columns not mentioned in the stored order (e.g. newly
    // added UDFs) land at the end.
    for (const c of movable) {
      if (byKey.has(c.key)) ordered.push(c);
    }
    return [...alwaysFirst, ...ordered];
  }, [rawColumns, order]);

  // Effective hidden = userHidden ∪ defaultHidden-not-explicitly-shown.
  // alwaysVisible columns short-circuit to visible.
  const effectiveHidden = useMemo(() => {
    const set = new Set(userHidden);
    for (const c of allColumns) {
      if (c.defaultHidden && !userShown.has(c.key)) set.add(c.key);
    }
    return set;
  }, [allColumns, userHidden, userShown]);

  const visibleColumns = useMemo(
    () => allColumns.filter((c) => c.alwaysVisible || !effectiveHidden.has(c.key)),
    [allColumns, effectiveHidden]
  );

  // Render order with pinned columns hoisted to the front. alwaysVisible
  // columns keep their existing front position; pinned-but-not-always
  // columns slot in directly after them (preserving each group's relative
  // order). Everything else follows. When nothing is pinned this is
  // identical to `visibleColumns`, so the default render is unchanged.
  const displayColumns = useMemo(() => {
    if (pinnedSet.size === 0) return visibleColumns;
    const always = visibleColumns.filter((c) => c.alwaysVisible);
    const pinnedCols = visibleColumns.filter(
      (c) => !c.alwaysVisible && pinnedSet.has(c.key)
    );
    const rest = visibleColumns.filter(
      (c) => !c.alwaysVisible && !pinnedSet.has(c.key)
    );
    return [...always, ...pinnedCols, ...rest];
  }, [visibleColumns, pinnedSet]);

  // The contiguous run of sticky (frozen) columns at the front: every
  // alwaysVisible column plus any pinned column. They render with
  // `position: sticky` and cumulative `left` offsets. We treat the
  // leading alwaysVisible columns as sticky too so a pinned column never
  // scrolls "under" an unpinned-but-leading one. `stickyCount` is how many
  // of the leading `displayColumns` are sticky.
  const stickyCount = useMemo(() => {
    let n = 0;
    for (const c of displayColumns) {
      if (c.alwaysVisible || pinnedSet.has(c.key)) n++;
      else break;
    }
    // Only freeze the run if at least one column is *explicitly* pinned —
    // alwaysVisible alone shouldn't start sticking (that would change every
    // existing caller's scroll behaviour). When nothing is pinned, no
    // column is sticky.
    return pinnedSet.size === 0 ? 0 : n;
  }, [displayColumns, pinnedSet]);

  // Resolve a column's effective pixel width: user width wins, else the
  // column's own `width` if it parses as px, else a sane default. Used both
  // for the inline width style and for computing sticky-left offsets.
  const resolveWidth = useCallback(
    (col: Column<T>): number => {
      const user = widths[col.key];
      if (typeof user === "number" && user > 0) return user;
      const parsed = parsePxWidth(col.width);
      return parsed ?? DEFAULT_COL_WIDTH;
    },
    [widths]
  );

  // Cumulative left offset (px) for each sticky column, by index into
  // `displayColumns`. Index >= stickyCount → not sticky (offset unused).
  const stickyLeft = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (let i = 0; i < stickyCount; i++) {
      out[i] = acc;
      acc += resolveWidth(displayColumns[i]);
    }
    return out;
  }, [displayColumns, stickyCount, resolveWidth]);

  const chooserOptions = useMemo(
    () =>
      allColumns
        .filter((c) => !c.alwaysVisible)
        .map((c) => ({ key: c.key, label: c.label || c.key })),
    [allColumns]
  );

  function toggleColumn(key: string) {
    const col = allColumns.find((c) => c.key === key);
    const isHidden = effectiveHidden.has(key);
    if (isHidden) {
      // Reveal: drop from userHidden, and (if defaultHidden) add to shown.
      setHiddenList((prev) => prev.filter((k) => k !== key));
      if (col?.defaultHidden) {
        setShownList((prev) => (prev.includes(key) ? prev : [...prev, key]));
      }
    } else {
      // Hide: add to userHidden, drop from shown.
      setHiddenList((prev) => (prev.includes(key) ? prev : [...prev, key]));
      setShownList((prev) => prev.filter((k) => k !== key));
    }
  }

  function resetVisibility() {
    setHiddenList([]);
    setShownList([]);
  }

  function resetOrder() {
    // Resetting order also clears widths + pinned so the table returns to a
    // clean default layout (no orphaned per-column sizes or frozen columns
    // left pointing at a now-rearranged set).
    setOrder([]);
    setWidths({});
    setPinned([]);
  }

  // ── Column resize ──────────────────────────────────────────
  // Dragging the right-edge handle updates `widths[key]`. The handle is a
  // dedicated element that stops propagation so it never triggers the
  // header's sort-on-click. Double-clicking the handle auto-fits (clears
  // the column's stored width). Pointer events + capture give us a clean
  // drag without a global listener leak.
  const resizeRef = useRef<{ key: string; startX: number; startW: number } | null>(
    null
  );

  function onResizeStart(e: React.MouseEvent, col: Column<T>) {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      key: col.key,
      startX: e.clientX,
      startW: resolveWidth(col),
    };
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const next = Math.max(MIN_COL_WIDTH, r.startW + (ev.clientX - r.startX));
      setWidths((prev) => ({ ...prev, [r.key]: next }));
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Auto-fit = clear the stored width so the column falls back to its
  // natural / default size. (We don't measure the DOM; clearing is the
  // predictable, persistence-friendly behaviour.)
  function autoFitColumn(key: string) {
    setWidths((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // ── Pin / freeze (left) ────────────────────────────────────
  function togglePin(key: string) {
    setPinned((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  function handleExport() {
    if (!sortedRows || sortedRows.length === 0) return;
    const csvCols: CSVColumn<T>[] = visibleColumns
      .filter((c) => typeof c.getValue === "function")
      .map((c) => ({
        key: c.key,
        label: c.label || c.key,
        getValue: c.getValue!,
      }));
    if (csvCols.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV(`${exportName || tableId || "export"}-${date}.csv`, toCSV(sortedRows, csvCols));
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && onImport) onImport(f);
    e.target.value = "";
  }

  // ── Sorting ────────────────────────────────────────────
  // Clicking a sortable header cycles: none → asc → desc → none.
  // - Default (client mode): sort applies in-memory to the rows passed in.
  // - Server mode (serverSort): in-memory sort is skipped and the new
  //   sort state is reported via onSortChange so the parent can re-query
  //   with sort_by/sort_dir. This makes ordering apply across the full
  //   dataset, not just the visible page.

  function onHeaderClick(col: Column<T>) {
    if (!col.getValue || col.disableSort) return;
    setSort((cur) => {
      let next: SortState | null;
      if (!cur || cur.key !== col.key) next = { key: col.key, dir: "asc" };
      else if (cur.dir === "asc") next = { key: col.key, dir: "desc" };
      else next = null;
      if (serverSort && onSortChange) onSortChange(next);
      return next;
    });
  }

  // Set an explicit sort direction for a column (used by the header
  // context menu's "Sort ascending / descending"). Mirrors onHeaderClick's
  // server-mode reporting so server-sorted tables re-query.
  function applySort(col: Column<T>, dir: SortDir) {
    if (!col.getValue || col.disableSort) return;
    const next: SortState = { key: col.key, dir };
    setSort(next);
    if (serverSort && onSortChange) onSortChange(next);
  }

  // On mount, if the parent is in server-sort mode and we restored a
  // sort from localStorage, push it up so the initial query matches.
  // (Effect, not render, so we don't fire during render.)
  useEffect(() => {
    if (serverSort && onSortChange) onSortChange(sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the header context menu on any outside click, Escape, or scroll
  // (the menu is positioned at fixed page coordinates, so a scroll would
  // detach it from its anchor). Clicks inside the menu stop propagation.
  useEffect(() => {
    if (!headerMenu) return;
    const close = () => setHeaderMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [headerMenu]);

  // Close the row context menu on outside click, Escape, or scroll — same
  // detach-from-anchor reasoning as the header menu (it's fixed-positioned).
  useEffect(() => {
    if (!rowMenu) return;
    const close = () => setRowMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [rowMenu]);

  const sortedRows = useMemo(() => {
    if (!rows) return rows;
    if (serverSort) return rows; // backend already ordered
    if (!sort) return rows;
    const col = allColumns.find((c) => c.key === sort.key);
    if (!col || !col.getValue) return rows;
    const getter = col.getValue;
    const mul = sort.dir === "asc" ? 1 : -1;
    // Stable-ish copy — Array.prototype.sort is stable in modern engines.
    const copy = rows.slice();
    copy.sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      return compareValues(av, bv) * mul;
    });
    return copy;
  }, [rows, sort, allColumns, serverSort]);

  // Total column span for full-width body cells (skeleton / error / empty /
  // expansion). The chevron column (when `expandable`) adds one leading
  // column that isn't in `displayColumns`. When no chevron, this equals
  // `displayColumns.length`, so non-expandable callers are unchanged.
  const expandColCount = expandable ? 1 : 0;
  const totalColSpan = displayColumns.length + expandColCount;

  // ── Group-by (opt-in) ──────────────────────────────────────
  // Flatten the sorted rows into a list of render instructions — a group
  // header followed by its rows (unless collapsed). Single level only (the
  // prop is a single key). When `groupBy` is unset we keep a plain
  // `{ kind: "row" }` stream so the tbody map below is identical to the old
  // flat render. Grouping needs a `getValue` on the target column for a
  // stable bucket key; if that's missing we silently fall back to flat.
  type RenderItem =
    | { kind: "group"; value: string; label: string; count: number; collapsed: boolean }
    | { kind: "row"; row: T; rowIdx: number };
  const groupCol = useMemo(
    () =>
      groupBy ? allColumns.find((c) => c.key === groupBy.key) ?? null : null,
    [groupBy, allColumns]
  );
  const renderList = useMemo<RenderItem[]>(() => {
    if (!sortedRows) return [];
    if (!groupBy || !groupCol || !groupCol.getValue) {
      return sortedRows.map((row, rowIdx) => ({ kind: "row", row, rowIdx }));
    }
    const getter = groupCol.getValue;
    // Preserve first-seen group order (sortedRows already reflects any active
    // sort), bucketing rows by their stringified group value.
    const order: string[] = [];
    const buckets = new Map<string, T[]>();
    for (const row of sortedRows) {
      const raw = getter(row);
      const val = raw == null || raw === "" ? "" : String(raw);
      if (!buckets.has(val)) {
        buckets.set(val, []);
        order.push(val);
      }
      buckets.get(val)!.push(row);
    }
    const out: RenderItem[] = [];
    let rowIdx = 0;
    for (const val of order) {
      const bucket = buckets.get(val)!;
      const collapsed = collapsedGroupSet.has(val);
      out.push({
        kind: "group",
        value: val,
        label: groupBy.label ? groupBy.label(val) : val || "(blank)",
        count: bucket.length,
        collapsed,
      });
      if (!collapsed) {
        for (const row of bucket) {
          out.push({ kind: "row", row, rowIdx });
          rowIdx++;
        }
      } else {
        // Keep the zebra index advancing past collapsed rows so re-expanding
        // doesn't shift the stripe pattern of later rows.
        rowIdx += bucket.length;
      }
    }
    return out;
  }, [sortedRows, groupBy, groupCol, collapsedGroupSet]);

  // Density-aware cell padding. Tightened on 2026-05-08 — every row
  // is one line of data, full stop. Old comfy (py-3.5) and old
  // compact (py-2) both wasted vertical space; the new values
  // collapse to a single 13px line + minimal cushion on each side.
  // Headers stay one notch taller so the column boundary still reads.
  // Permanently comfy (density toggle removed 2026-06).
  const cellPad = "px-3 py-1.5 leading-tight";
  const headPad = "px-3 py-2 leading-tight";

  // Common toolbar button class — used by Import / Export / Density / Columns.
  // 44 px on mobile (touch-target floor), compresses to 32 px on sm+ where
  // mouse precision is available.
  const toolbarBtn =
    "inline-flex h-11 sm:h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-surface disabled:hover:text-ink-secondary";

  const rowCount = sortedRows?.length ?? 0;
  const visibleCount = chooserOptions.filter((o) => !effectiveHidden.has(o.key)).length;

  return (
    <div>
      {/* ── Toolbar (always rendered) ──────────────────────── */}
      <div className="mb-2.5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2 sm:gap-3">
          {search && (
            <div className="relative w-full sm:w-72 sm:max-w-full">
              <Search
                size={13}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
              />
              <input
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={search.placeholder || "Search…"}
                className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20 sm:h-8 sm:text-[12px]"
              />
            </div>
          )}
          {resetFilters && (
            <ResetFiltersButton
              active={resetFilters.active}
              onReset={resetFilters.onReset}
              label={resetFilters.label}
            />
          )}
          <div className="flex items-center gap-2 text-[11px] font-medium text-ink-secondary">
            {caption && (
              <>
                <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  {caption}
                </span>
                <span className="text-ink-muted">·</span>
              </>
            )}
            {rows ? (
              <span>
                <span className="font-mono text-ink">{rowCount.toLocaleString()}</span>
                <span className="ml-1 text-ink-muted">{rowCount === 1 ? "row" : "rows"}</span>
                <span className="mx-2 text-ink-muted">·</span>
                <span className="font-mono text-ink">{visibleColumns.length}</span>
                <span className="ml-1 text-ink-muted">of {allColumns.length} cols</span>
              </span>
            ) : (
              <span className="text-ink-muted">Loading…</span>
            )}
          </div>
        </div>
        <div className="mask-fade-r no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          {onImport && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                className="hidden"
              />
              <button onClick={handleImportClick} className={toolbarBtn}>
                <Upload size={13} />
                Import
              </button>
            </>
          )}
          <button
            onClick={handleExport}
            disabled={!sortedRows || sortedRows.length === 0}
            className={toolbarBtn}
          >
            <Download size={13} />
            Export
          </button>
          {/* Density toggle removed 2026-06 — layout is permanently comfy. */}
          {/* Mobile-only: flip between cards and the desktop-style table
              (horizontally scrollable). Hidden on `sm+` because the
              table is already the default there. */}
          <button
            onClick={() =>
              setMobileView(mobileView === "cards" ? "table" : "cards")
            }
            className={cn(toolbarBtn, "sm:hidden")}
            title={
              mobileView === "cards"
                ? "Switch to table view"
                : "Switch to card view"
            }
            aria-label={
              mobileView === "cards"
                ? "Switch to table view"
                : "Switch to card view"
            }
          >
            {mobileView === "cards" ? (
              <TableIcon size={13} />
            ) : (
              <LayoutList size={13} />
            )}
            {mobileView === "cards" ? "Table" : "Cards"}
          </button>
          <ColumnsPanelButton
            visibleCount={visibleCount}
            totalCount={chooserOptions.length}
            onClick={() => setChooserOpen(true)}
            active={chooserOpen}
          />
        </div>
      </div>

      {/* Columns + UDF side panel */}
      <ColumnsPanel
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        options={chooserOptions}
        hidden={effectiveHidden}
        onToggle={toggleColumn}
        onResetVisibility={resetVisibility}
        onReorder={setOrder}
        onResetOrder={resetOrder}
        udf={udfTable ? udf : undefined}
        udfTableLabel={udfTableLabel || udfTable}
      />

      {/* ── Table (sm+ always; on `<sm` only when mobileView=table). The
            outer wrapper drops `overflow-hidden` when forced on mobile
            so the rounded corners don't clip the horizontal scroll
            shadow at the right edge. */}
      <div
        className={cn(
          "rounded-lg border border-border bg-surface shadow-stone sm:block sm:overflow-hidden",
          mobileView === "table" ? "block" : "hidden",
        )}
      >
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10">
              <tr>
                {expandable && (
                  <th
                    aria-hidden
                    style={{ width: 32, minWidth: 32, maxWidth: 32 }}
                    className={cn(
                      "border-b-2 border-border bg-surface-dim pl-5",
                      headPad
                    )}
                  />
                )}
                {displayColumns.map((c, i) => {
                  const sortable = !!c.getValue && !c.disableSort;
                  const active = sort?.key === c.key;
                  const isSticky = i < stickyCount;
                  const isLastSticky = isSticky && i === stickyCount - 1;
                  const userW = widths[c.key];
                  // Inline sizing: a user width (px) always wins; otherwise
                  // fall through to the column's own `width` string. When a
                  // width is in force we also pin min/max to it so the cell
                  // actually holds the size instead of the browser
                  // redistributing free space.
                  const cellStyle: React.CSSProperties = {};
                  if (typeof userW === "number") {
                    cellStyle.width = userW;
                    cellStyle.minWidth = userW;
                    cellStyle.maxWidth = userW;
                  } else if (c.width) {
                    cellStyle.width = c.width;
                  }
                  if (isSticky) {
                    cellStyle.position = "sticky";
                    cellStyle.left = stickyLeft[i];
                    // Above body sticky cells (z-20) and the sticky header
                    // baseline (the thead is z-10); 30 keeps frozen headers
                    // on top of everything during a two-axis scroll.
                    cellStyle.zIndex = 30;
                  }
                  return (
                    <th
                      key={c.key}
                      style={cellStyle}
                      onClick={() => sortable && onHeaderClick(c)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setHeaderMenu({ x: e.clientX, y: e.clientY, colKey: c.key });
                      }}
                      className={cn(
                        "group/th relative border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink",
                        headPad,
                        c.align === "right" && "text-right",
                        c.align === "center" && "text-center",
                        (c.align === "left" || !c.align) && "text-left",
                        // First real column owns the left edge gutter only
                        // when there's no leading chevron column ahead of it.
                        i === 0 && !expandable && "pl-5",
                        i === displayColumns.length - 1 && "pr-5",
                        sortable && "cursor-pointer select-none hover:text-primary",
                        active && "text-primary",
                        // Delineate the frozen region: a right border on the
                        // last sticky column reads as the freeze line.
                        isLastSticky && "border-r border-border"
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        {c.renderHeader ? (
                          c.renderHeader()
                        ) : (
                          <>
                            {pinnedSet.has(c.key) && (
                              <Pin
                                size={9}
                                className="shrink-0 text-primary"
                                aria-label="Pinned"
                              />
                            )}
                            {c.label}
                            {sortable && (
                              <span
                                className={cn(
                                  "inline-flex transition-opacity",
                                  active ? "opacity-100" : "opacity-30"
                                )}
                              >
                                {active ? (
                                  sort!.dir === "asc" ? (
                                    <ArrowUp size={10} />
                                  ) : (
                                    <ArrowDown size={10} />
                                  )
                                ) : (
                                  <ChevronsUpDown size={10} />
                                )}
                              </span>
                            )}
                          </>
                        )}
                      </span>
                      {/* Resize handle — a dedicated right-edge strip. It
                          stops click/contextmenu propagation so dragging it
                          never sorts or opens the column menu. Double-click
                          auto-fits (clears the stored width). */}
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize column"
                        onMouseDown={(e) => onResizeStart(e, c)}
                        onClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          autoFitColumn(c.key);
                        }}
                        className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none opacity-0 transition-opacity hover:bg-primary/40 group-hover/th:opacity-100"
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && <TableSkeleton rows={8} cols={totalColSpan} />}
              {!loading && error && (
                <tr>
                  <td
                    colSpan={totalColSpan}
                    className="px-3 py-14 text-center text-sm text-err"
                  >
                    <div className="font-semibold">Failed to load</div>
                    <div className="mt-1 text-xs text-ink-muted">{error}</div>
                  </td>
                </tr>
              )}
              {!loading && !error && sortedRows && sortedRows.length === 0 && (
                <tr>
                  <td
                    colSpan={totalColSpan}
                    className="px-3 py-20 text-center text-sm text-ink-muted"
                  >
                    {emptyLabel}
                  </td>
                </tr>
              )}
              {!loading &&
                !error &&
                sortedRows &&
                renderList.map((item) => {
                  // ── Group header row (opt-in `groupBy`) ──
                  if (item.kind === "group") {
                    return (
                      <tr
                        key={`grp:${item.value}`}
                        onClick={() => toggleGroup(item.value)}
                        className="cursor-pointer select-none bg-surface-dim/70 transition-colors hover:bg-surface-dim"
                      >
                        <td
                          colSpan={totalColSpan}
                          className={cn(
                            "border-b border-border-subtle pr-5 text-[11px] font-semibold uppercase tracking-brand text-ink",
                            cellPad
                          )}
                        >
                          <span className="inline-flex items-center gap-1.5 pl-5">
                            <ChevronRight
                              size={12}
                              className={cn(
                                "shrink-0 text-ink-muted transition-transform",
                                !item.collapsed && "rotate-90"
                              )}
                              aria-hidden
                            />
                            <span>{item.label}</span>
                            <span className="font-mono text-[10px] font-normal text-ink-muted">
                              ({item.count})
                            </span>
                          </span>
                        </td>
                      </tr>
                    );
                  }

                  // ── Data row ──
                  const { row, rowIdx } = item;
                  const customClass = getRowClassName?.(row);
                  // Opaque zebra background for sticky cells. A sticky cell
                  // must occlude the body content scrolling beneath it, so
                  // it needs a solid fill (the row's own bg sits on the
                  // <tr>, which doesn't paint over the sliding siblings).
                  // Odd-row value = `surface-dim` (#ecebe2) at 35% over the
                  // white surface, pre-blended so there's no visible seam.
                  const stickyBg =
                    rowIdx % 2 === 0 ? "#ffffff" : "#f8f8f5";
                  const expId = expandable ? expansionId(row) : null;
                  const isExpanded = expId != null && expandedRows.has(expId);
                  return (
                    <Fragment key={getRowKey(row)}>
                      <tr
                        onClick={onRowClick ? () => onRowClick(row) : undefined}
                        onContextMenu={
                          contextMenu
                            ? (e) => {
                                const items = contextMenu(row);
                                if (!items || items.length === 0) return;
                                e.preventDefault();
                                e.stopPropagation();
                                setRowMenu({ x: e.clientX, y: e.clientY, items });
                              }
                            : undefined
                        }
                        className={cn(
                          "group transition-colors",
                          rowIdx % 2 === 0 ? "bg-surface" : "bg-surface-dim/35",
                          onRowClick && "cursor-pointer",
                          customClass
                        )}
                      >
                        {/* Chevron drill-down cell (opt-in `expandable`).
                            Stops click propagation so toggling the row's
                            expansion never also fires onRowClick. */}
                        {expandable && (
                          <td
                            style={{ width: 32, minWidth: 32, maxWidth: 32 }}
                            className={cn(
                              "border-b border-border-subtle pl-5 align-middle text-ink transition-colors group-hover:bg-[#3f6b53]/25",
                              cellPad
                            )}
                          >
                            <button
                              type="button"
                              aria-label={isExpanded ? "Collapse row" : "Expand row"}
                              aria-expanded={isExpanded}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (expId != null) toggleExpand(expId);
                              }}
                              className="inline-flex items-center justify-center rounded text-ink-muted transition-colors hover:text-primary"
                            >
                              <ChevronRight
                                size={14}
                                className={cn(
                                  "transition-transform",
                                  isExpanded && "rotate-90"
                                )}
                                aria-hidden
                              />
                            </button>
                          </td>
                        )}
                        {displayColumns.map((c, i) => {
                          const isSticky = i < stickyCount;
                          const isLastSticky = isSticky && i === stickyCount - 1;
                          const userW = widths[c.key];
                          const cellStyle: React.CSSProperties = {};
                          if (typeof userW === "number") {
                            cellStyle.width = userW;
                            cellStyle.minWidth = userW;
                            cellStyle.maxWidth = userW;
                          } else if (c.width) {
                            cellStyle.width = c.width;
                          }
                          if (isSticky) {
                            cellStyle.position = "sticky";
                            cellStyle.left = stickyLeft[i];
                            cellStyle.zIndex = 20;
                            cellStyle.background = stickyBg;
                          }
                          return (
                            <td
                              key={c.key}
                              style={cellStyle}
                              className={cn(
                                "border-b border-border-subtle text-[13px] text-ink transition-colors",
                                cellPad,
                                // Single-line rule (2026-05-08). Cells stop
                                // wrapping their text content; long values
                                // overflow into the next cell visually but
                                // never push the row to two lines. Render
                                // functions that genuinely need multi-line
                                // (rare) can opt back in via `c.className`
                                // ("whitespace-normal").
                                "whitespace-nowrap",
                                // Pine-green tint on hover (matches the
                                // calendar's "on track" green). Reads clearly
                                // on both zebra shades. (Was a pale brass
                                // `accent-soft` wash that looked yellow.)
                                "group-hover:bg-[#3f6b53]/25",
                                c.align === "right" && "text-right",
                                c.align === "center" && "text-center",
                                // Leading gutter belongs to the chevron cell
                                // when expandable; otherwise the first column.
                                i === 0 && !expandable && "pl-5",
                                i === displayColumns.length - 1 && "pr-5",
                                // Freeze line on the last sticky column.
                                isLastSticky && "border-r border-border",
                                c.className
                              )}
                            >
                              {c.render(row)}
                            </td>
                          );
                        })}
                      </tr>
                      {/* Inline expanded sub-row (opt-in `expandable`). Spans
                          the full width; renders the caller's drill-down. */}
                      {isExpanded && expandable && (
                        <tr className="bg-surface-dim/20">
                          <td
                            colSpan={totalColSpan}
                            className="border-b border-border-subtle px-5 py-3 text-[13px] text-ink"
                          >
                            {expandable.render(row)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Mobile card list (<sm) ─────────────────────────────
          Same data, stacked-card layout. The first visible column
          becomes the card title; subsequent columns render as
          label/value rows. Skips the row entirely if the user
          intentionally hid the first column. */}
      <div
        className={cn(
          "space-y-2 sm:hidden",
          mobileView === "table" && "hidden",
        )}
      >
        {loading && (
          <>
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="rounded-lg border border-border bg-surface p-3 shadow-stone"
              >
                <div className="mb-2 h-4 w-2/3 animate-pulse rounded bg-bg/80" />
                <div className="space-y-1.5">
                  <div className="h-3 w-full animate-pulse rounded bg-bg/60" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-bg/60" />
                </div>
              </div>
            ))}
          </>
        )}
        {!loading && error && (
          <div className="rounded-lg border border-err/40 bg-err/5 p-4 text-center text-sm text-err">
            <div className="font-semibold">Failed to load</div>
            <div className="mt-1 text-xs text-ink-muted">{error}</div>
          </div>
        )}
        {!loading && !error && sortedRows && sortedRows.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-ink-muted">
            {emptyLabel}
          </div>
        )}
        {!loading &&
          !error &&
          sortedRows &&
          sortedRows.map((row) => {
            const customClass = getRowClassName?.(row);
            // Resolve title + cells. When `mobileCard` is unset, fall
            // back to the legacy shape (first visible column = title,
            // remainder as labelled rows). When set, honour the
            // explicit `primary` / `cells` keys.
            const colByKey = new Map(visibleColumns.map((c) => [c.key, c]));
            let primaryCol = visibleColumns[0];
            let cellCols = visibleColumns.slice(1);
            if (mobileCard) {
              if (mobileCard.primary) {
                primaryCol =
                  colByKey.get(mobileCard.primary) ?? primaryCol;
              }
              if (mobileCard.cells) {
                cellCols = mobileCard.cells
                  .map((k) => colByKey.get(k))
                  .filter((c): c is Column<T> => !!c);
              } else {
                cellCols = visibleColumns.filter(
                  (c) => c.key !== primaryCol?.key,
                );
              }
            }
            const layout = mobileCard?.layout ?? "stack";
            const hideLabels = mobileCard?.hideLabels ?? layout === "grid-2";
            return (
              <div
                key={getRowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                className={cn(
                  "relative overflow-hidden rounded-lg border border-border bg-surface shadow-stone transition-colors",
                  onRowClick &&
                    "cursor-pointer active:bg-primary/15 hover:border-primary/40",
                  customClass,
                )}
              >
                {/* Petrol accent rail — subtle anchor on the left edge of a
                    clickable row card, matches the IdeaList card pattern. */}
                <span className="pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-gradient-to-b from-primary/0 via-primary/55 to-primary/0" />
                <div className="p-3">
                  {primaryCol && (
                    <div className="mb-1.5 flex items-start gap-3">
                      <div className="min-w-0 flex-1 font-display text-[14.5px] font-extrabold leading-snug tracking-tight text-ink">
                        {primaryCol.render(row)}
                      </div>
                      {onRowClick && (
                        <ChevronRight
                          size={14}
                          className="mt-1 shrink-0 text-ink-muted"
                          aria-hidden
                        />
                      )}
                    </div>
                  )}
                  {cellCols.length > 0 && layout === "grid-2" && (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
                      {cellCols.map((c) => (
                        <dd
                          key={c.key}
                          className={cn(
                            // Always left-align in card view so cells
                            // don't zig-zag between the left and right
                            // edges of their column. `tabular-nums`
                            // still keeps numeric digits in lockstep.
                            "min-w-0 break-words text-left text-ink-secondary",
                            c.align === "right" && "tabular-nums font-semibold",
                            c.className,
                          )}
                        >
                          {c.render(row)}
                        </dd>
                      ))}
                    </dl>
                  )}
                  {cellCols.length > 0 && layout === "stack" && (
                    <dl
                      className={cn(
                        "grid gap-x-3 gap-y-1 border-t border-border-subtle pt-2 text-[12.5px]",
                        hideLabels ? "grid-cols-1" : "grid-cols-[5.5rem_1fr]",
                      )}
                    >
                      {cellCols.map((c) => (
                        <Fragment key={c.key}>
                          {!hideLabels && (
                            <dt className="self-start pt-px font-mono text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted sm:text-[9.5px]">
                              {c.label}
                            </dt>
                          )}
                          <dd
                            className={cn(
                              // Always left-align in card view. The
                              // desktop column's `align: "right"` only
                              // gets us tabular-nums + a heavier weight
                              // here — flipping the entire cell to the
                              // right edge creates a jagged value
                              // column when stacked with left-aligned
                              // siblings.
                              "min-w-0 break-words text-left font-medium text-ink",
                              c.align === "right" &&
                                "tabular-nums font-semibold",
                              c.className,
                            )}
                          >
                            {c.render(row)}
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      {/* ── Header right-click context menu ──────────────────────
          Portalled to <body> so it escapes the table's overflow clip
          and sticky-header stacking context. Acts on the clicked
          column. Closes on outside click / Esc / scroll (effect above). */}
      {headerMenu &&
        (() => {
          const col = allColumns.find((c) => c.key === headerMenu.colKey);
          if (!col) return null;
          const sortable = !!col.getValue && !col.disableSort;
          const isPinned = pinnedSet.has(col.key);
          const canHide = !col.alwaysVisible;
          const itemCls =
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-surface-dim disabled:cursor-not-allowed disabled:text-ink-muted disabled:hover:bg-transparent";
          return createPortal(
            <div
              className="fixed z-[120] min-w-[176px] overflow-hidden rounded-md border border-border bg-surface py-1 shadow-slab"
              style={{ top: headerMenu.y, left: headerMenu.x }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                type="button"
                className={itemCls}
                disabled={!sortable}
                onClick={() => {
                  applySort(col, "asc");
                  setHeaderMenu(null);
                }}
              >
                <ArrowUp size={13} className="shrink-0 text-ink-muted" />
                Sort ascending
              </button>
              <button
                type="button"
                className={itemCls}
                disabled={!sortable}
                onClick={() => {
                  applySort(col, "desc");
                  setHeaderMenu(null);
                }}
              >
                <ArrowDown size={13} className="shrink-0 text-ink-muted" />
                Sort descending
              </button>
              <div className="my-1 border-t border-border-subtle" />
              <button
                type="button"
                className={itemCls}
                onClick={() => {
                  togglePin(col.key);
                  setHeaderMenu(null);
                }}
              >
                {isPinned ? (
                  <PinOff size={13} className="shrink-0 text-ink-muted" />
                ) : (
                  <Pin size={13} className="shrink-0 text-ink-muted" />
                )}
                {isPinned ? "Unpin left" : "Pin left"}
              </button>
              <button
                type="button"
                className={itemCls}
                onClick={() => {
                  autoFitColumn(col.key);
                  setHeaderMenu(null);
                }}
              >
                <MoveHorizontal size={13} className="shrink-0 text-ink-muted" />
                Auto-fit width
              </button>
              <div className="my-1 border-t border-border-subtle" />
              <button
                type="button"
                className={itemCls}
                disabled={!canHide}
                onClick={() => {
                  if (canHide) toggleColumn(col.key);
                  setHeaderMenu(null);
                }}
              >
                <EyeOff size={13} className="shrink-0 text-ink-muted" />
                Hide column
              </button>
            </div>,
            document.body
          );
        })()}

      {/* ── Row right-click context menu (opt-in `contextMenu`) ──────
          Portalled to <body> — same escape-the-overflow/stacking reasoning
          as the header menu, but at a higher z so it clears the sticky
          <thead>. Items + danger/divider come from `contextMenu(row)`,
          resolved when the menu opened. Closes on outside click / Esc /
          scroll (effect above). */}
      {rowMenu &&
        createPortal(
          <div
            className="fixed z-[130] min-w-[176px] overflow-hidden rounded-md border border-border bg-surface py-1 shadow-slab"
            style={{ top: rowMenu.y, left: rowMenu.x }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {rowMenu.items.map((it, i) => {
              if (it.divider) {
                return (
                  <div
                    key={`div-${i}`}
                    className="my-1 border-t border-border-subtle"
                  />
                );
              }
              return (
                <button
                  key={`item-${i}-${it.label}`}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors",
                    it.danger
                      ? "text-err hover:bg-err/10"
                      : "text-ink hover:bg-surface-dim"
                  )}
                  onClick={() => {
                    // Close before firing — a handler may navigate or open a
                    // dialog, and we don't want a stale menu lingering.
                    setRowMenu(null);
                    it.onClick();
                  }}
                >
                  {it.label}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

// ── Sort comparator ──────────────────────────────────────────
// Handles the common shapes getValue returns: null/undefined last,
// then numbers numerically, then strings case-insensitively, then
// booleans (false < true).

// Parse a column's `width` CSS string into a pixel number when possible.
// "120px" → 120, "120" → 120. Non-px units ("20%", "8rem") and undefined
// return null so the caller falls back to DEFAULT_COL_WIDTH for offset math
// (the inline width style still passes the original string through for those).
function parsePxWidth(width: string | undefined): number | null {
  if (!width) return null;
  const m = /^(\d+(?:\.\d+)?)(px)?$/.exec(width.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function compareValues(
  a: string | number | boolean | null | undefined,
  b: string | number | boolean | null | undefined
): number {
  const aNull = a == null || a === "";
  const bNull = b == null || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;   // nulls sink to the bottom regardless of direction reversal's impact
  if (bNull) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  // ISO-like date strings compare fine as strings, so no special handling
  // is needed — "2026-04-16" < "2026-04-17" under string compare.
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}
