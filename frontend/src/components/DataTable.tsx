import { useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Upload, Rows3, Rows4, Sparkles, Search } from "lucide-react";
import { cn } from "../lib/utils";
import { TableSkeleton } from "./Skeleton";
import { ColumnChooser } from "./ColumnChooser";
import { UdfManager } from "./UdfManager";
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
  /** Provide a raw value for CSV export. Columns without this are skipped during export. */
  getValue?: (row: T) => string | number | boolean | null | undefined;
  /** If true, the column is excluded from the column chooser (always visible). */
  alwaysVisible?: boolean;
}

interface Props<T> {
  /** Stable identifier used for persisting column visibility & density per page (localStorage). */
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
   * Backend table identifier for user-defined fields. When set, the table
   * gains a "Fields" toolbar button, dynamic UDF columns, and per-row
   * inline editing. UDFs are stored in worker D1 and never synced to
   * AutoCount. Pass undefined to disable.
   */
  udfTable?: string;
  /** Friendly label used in the UDF manager modal. Defaults to udfTable. */
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
}

type Density = "comfy" | "compact";

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
}: Props<T>) {
  const idKey = tableId || "_";
  const [hiddenList, setHiddenList] = useLocalStorage<string[]>(`dt:hidden:${idKey}`, []);
  const [density, setDensity] = useLocalStorage<Density>(`dt:density:${idKey}`, "comfy");
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── UDF integration ─────────────────────────────────────
  const udf: UseUdfResult = useUdf(udfTable);
  const [udfManagerOpen, setUdfManagerOpen] = useState(false);

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

  const allColumns = useMemo(() => [...columns, ...udfColumns], [columns, udfColumns]);

  const visibleColumns = useMemo(
    () => allColumns.filter((c) => c.alwaysVisible || !hidden.has(c.key)),
    [allColumns, hidden]
  );

  const chooserOptions = useMemo(
    () =>
      allColumns
        .filter((c) => !c.alwaysVisible)
        .map((c) => ({ key: c.key, label: c.label || c.key })),
    [allColumns]
  );

  function toggleColumn(key: string) {
    setHiddenList((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return Array.from(next);
    });
  }

  function resetColumns() {
    setHiddenList([]);
  }

  function handleExport() {
    if (!rows || rows.length === 0) return;
    const csvCols: CSVColumn<T>[] = visibleColumns
      .filter((c) => typeof c.getValue === "function")
      .map((c) => ({
        key: c.key,
        label: c.label || c.key,
        getValue: c.getValue!,
      }));
    if (csvCols.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCSV(`${exportName || tableId || "export"}-${date}.csv`, toCSV(rows, csvCols));
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && onImport) onImport(f);
    e.target.value = "";
  }

  // Density-aware cell padding
  const cellPad = density === "compact" ? "px-4 py-2" : "px-4 py-3.5";
  const headPad = density === "compact" ? "px-4 py-2.5" : "px-4 py-3";

  // Common toolbar button class — used by Import / Export / Density / Columns
  const toolbarBtn =
    "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-surface disabled:hover:text-ink-secondary";

  const rowCount = rows?.length ?? 0;

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
        <div className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
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
            disabled={!rows || rows.length === 0}
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
          {udfTable && (
            <button
              onClick={() => setUdfManagerOpen(true)}
              className={toolbarBtn}
              title="Manage user-defined fields (local only — never synced to AutoCount)"
            >
              <Sparkles size={13} />
              Fields {udf.fields.length > 0 && `(${udf.fields.length})`}
            </button>
          )}
          <ColumnChooser
            options={chooserOptions}
            hidden={hidden}
            onToggle={toggleColumn}
            onReset={resetColumns}
          />
        </div>
      </div>

      {udfTable && (
        <UdfManager
          open={udfManagerOpen}
          onClose={() => setUdfManagerOpen(false)}
          udf={udf}
          tableLabel={udfTableLabel || udfTable}
        />
      )}

      {/* ── Table ─────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        {/* Horizontal scroll only — the table grows vertically with rows
            so the entire page (not the table) scrolls when content exceeds
            the viewport. The pagination control at the bottom keeps the
            row count bounded. */}
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10">
              <tr>
                {visibleColumns.map((c, i) => (
                  <th
                    key={c.key}
                    style={c.width ? { width: c.width } : undefined}
                    className={cn(
                      // sticky needs each cell to carry its own bg
                      "border-b-2 border-border bg-surface-dim text-[10px] font-semibold uppercase tracking-brand text-ink-secondary",
                      headPad,
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                      (c.align === "left" || !c.align) && "text-left",
                      i === 0 && "pl-5",
                      i === visibleColumns.length - 1 && "pr-5"
                    )}
                  >
                    {c.label}
                  </th>
                ))}
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
              {!loading && !error && rows && rows.length === 0 && (
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
                rows &&
                rows.map((row, rowIdx) => {
                  const customClass = getRowClassName?.(row);
                  return (
                    <tr
                      key={getRowKey(row)}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={cn(
                        "group transition-colors",
                        // Zebra base — no border between rows, the alt bg
                        // does the visual separation. Cells handle the
                        // bottom hairline so sticky headers don't break.
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
    </div>
  );
}
