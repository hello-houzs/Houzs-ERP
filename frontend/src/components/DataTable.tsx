import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Download,
  Upload,
  Rows3,
  Rows4,
  Search,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  ChevronRight,
  LayoutList,
  Table as TableIcon,
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
}

type Density = "comfy" | "compact";
type SortDir = "asc" | "desc";
interface SortState {
  key: string;
  dir: SortDir;
}

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
}: Props<T>) {
  const idKey = tableId || "_";
  const [hiddenList, setHiddenList] = useLocalStorage<string[]>(`dt:hidden:${idKey}`, []);
  // `shownList` lets the user opt-IN to a column that's defaultHidden=true.
  // We need a separate set (rather than relying on hiddenList alone) so a
  // defaultHidden column stays hidden until the user explicitly enables it.
  const [shownList, setShownList] = useLocalStorage<string[]>(`dt:shown:${idKey}`, []);
  const [order, setOrder] = useLocalStorage<string[]>(`dt:order:${idKey}`, []);
  const [density, setDensity] = useLocalStorage<Density>(`dt:density:${idKey}`, "comfy");
  const [sort, setSort] = useLocalStorage<SortState | null>(`dt:sort:${idKey}`, null);
  // Mobile-only view preference. "cards" renders the stacked cards
  // (default for `<sm`); "table" forces the desktop table with a
  // horizontal scroll. Persisted per-table so each list page
  // remembers the user's choice.
  const [mobileView, setMobileView] = useLocalStorage<"cards" | "table">(
    `dt:mview:${idKey}`,
    "cards",
  );
  const [chooserOpen, setChooserOpen] = useState(false);
  const userHidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const userShown = useMemo(() => new Set(shownList), [shownList]);

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
    const pinned = rawColumns.filter((c) => c.alwaysVisible);
    const movable = rawColumns.filter((c) => !c.alwaysVisible);
    if (!order || order.length === 0) return [...pinned, ...movable];
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
    return [...pinned, ...ordered];
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
    setOrder([]);
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

  // On mount, if the parent is in server-sort mode and we restored a
  // sort from localStorage, push it up so the initial query matches.
  // (Effect, not render, so we don't fire during render.)
  useEffect(() => {
    if (serverSort && onSortChange) onSortChange(sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Density-aware cell padding. Tightened on 2026-05-08 — every row
  // is one line of data, full stop. Old comfy (py-3.5) and old
  // compact (py-2) both wasted vertical space; the new values
  // collapse to a single 13px line + minimal cushion on each side.
  // Headers stay one notch taller so the column boundary still reads.
  const cellPad =
    density === "compact" ? "px-3 py-1 leading-tight" : "px-3 py-1.5 leading-tight";
  const headPad =
    density === "compact" ? "px-3 py-1.5 leading-tight" : "px-3 py-2 leading-tight";

  // Common toolbar button class — used by Import / Export / Density / Columns.
  // 44 px on mobile (touch-target floor), compresses to 32 px on sm+ where
  // mouse precision is available.
  const toolbarBtn =
    "inline-flex h-11 sm:h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-surface disabled:hover:text-ink-secondary";

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
                className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20 sm:h-8 sm:text-[12px]"
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
          <button
            onClick={() => setDensity(density === "comfy" ? "compact" : "comfy")}
            className={toolbarBtn}
            title={density === "comfy" ? "Switch to compact rows" : "Switch to comfy rows"}
          >
            {density === "comfy" ? <Rows4 size={13} /> : <Rows3 size={13} />}
            {density === "comfy" ? "Comfy" : "Compact"}
          </button>
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
                {visibleColumns.map((c, i) => {
                  const sortable = !!c.getValue && !c.disableSort;
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      style={c.width ? { width: c.width } : undefined}
                      onClick={() => sortable && onHeaderClick(c)}
                      className={cn(
                        "border-b-2 border-border bg-surface-dim text-[10px] font-semibold uppercase tracking-brand text-ink-secondary",
                        headPad,
                        c.align === "right" && "text-right",
                        c.align === "center" && "text-center",
                        (c.align === "left" || !c.align) && "text-left",
                        i === 0 && "pl-5",
                        i === visibleColumns.length - 1 && "pr-5",
                        sortable && "cursor-pointer select-none hover:text-accent",
                        active && "text-accent"
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
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
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && <TableSkeleton rows={8} cols={visibleColumns.length} />}
              {!loading && error && (
                <tr>
                  <td
                    colSpan={visibleColumns.length}
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
                    colSpan={visibleColumns.length}
                    className="px-3 py-20 text-center text-sm text-ink-muted"
                  >
                    {emptyLabel}
                  </td>
                </tr>
              )}
              {!loading &&
                !error &&
                sortedRows &&
                sortedRows.map((row, rowIdx) => {
                  const customClass = getRowClassName?.(row);
                  return (
                    <tr
                      key={getRowKey(row)}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={cn(
                        "group transition-colors",
                        rowIdx % 2 === 0 ? "bg-surface" : "bg-surface-dim/35",
                        onRowClick && "cursor-pointer",
                        customClass
                      )}
                    >
                      {visibleColumns.map((c, i) => (
                        <td
                          key={c.key}
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
                            "group-hover:bg-accent-soft/55",
                            c.align === "right" && "text-right",
                            c.align === "center" && "text-center",
                            i === 0 && "pl-5",
                            i === visibleColumns.length - 1 && "pr-5",
                            c.className
                          )}
                        >
                          {c.render(row)}
                        </td>
                      ))}
                    </tr>
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
                    "cursor-pointer active:bg-accent-soft/40 hover:border-accent/40",
                  customClass,
                )}
              >
                {/* Brass accent rail — subtle anchor on the left edge,
                    matches the IdeaList card pattern. */}
                <span className="pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-gradient-to-b from-accent/0 via-accent/55 to-accent/0" />
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
    </div>
  );
}

// ── Sort comparator ──────────────────────────────────────────
// Handles the common shapes getValue returns: null/undefined last,
// then numbers numerically, then strings case-insensitively, then
// booleans (false < true).

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
