import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DataTable, type Column } from "../src/components/DataTable";
import { MobileVirtualList } from "../src/mobile/MobileVirtualList";
import {
  DataGrid,
  type DataGridColumn,
} from "../src/vendor/scm/components/DataGrid";
import "../src/vendor/design-system/tokens.css";
import "../src/index.css";
import "./perf-lab.css";

type Row = { id: number; name: string; detail: string };

const ROWS: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: index + 1,
  name: `Order ${String(index + 1).padStart(5, "0")}`,
  detail: index % 2 === 0
    ? `Short detail ${index + 1}`
    : `Long detail ${index + 1}: two deterministic lines exercise variable-height card geometry.`,
}));

const dataTableColumns: Column<Row>[] = [
  { key: "name", label: "Order", getValue: (row) => row.name, render: (row) => row.name },
  { key: "detail", label: "Detail", getValue: (row) => row.detail, render: (row) => row.detail },
];

const dataGridColumns: DataGridColumn<Row>[] = [
  { key: "name", label: "Order", accessor: (row) => row.name, searchValue: (row) => row.name },
  { key: "detail", label: "Detail", accessor: (row) => row.detail, searchValue: (row) => row.detail },
];

function DataTableLab({ mobile = false }: { mobile?: boolean }) {
  return (
    <main data-scenario={mobile ? "data-table-mobile" : "data-table-desktop"}>
      <DataTable
        tableId={`perf-data-table-${mobile ? "mobile" : "desktop"}`}
        rows={ROWS}
        columns={dataTableColumns}
        getRowKey={(row) => row.id}
        mobileCard={{ primary: "name", cells: ["detail"] }}
      />
    </main>
  );
}

function DataGridLab() {
  return (
    <main data-scenario="data-grid">
      <DataGrid
        rows={ROWS}
        columns={dataGridColumns}
        storageKey="perf-data-grid"
        rowKey={(row) => String(row.id)}
      />
    </main>
  );
}

function MobileVirtualListLab() {
  return (
    <main data-scenario="mobile-virtual-list">
      <MobileVirtualList
        items={ROWS}
        getKey={(row) => row.id}
        estimateHeight={114}
        renderItem={(row, index) => (
          <article className={index % 2 === 0 ? "lab-card lab-card-short" : "lab-card lab-card-tall"}>
            <strong>{row.name}</strong>
            <p>{row.detail}</p>
          </article>
        )}
      />
    </main>
  );
}

const SEARCH_ROWS: Row[] = [
  { id: 1, name: "A only result", detail: "matches A, not A1" },
  { id: 2, name: "A1 exact result", detail: "matches A1" },
  { id: 3, name: "B result", detail: "matches B" },
];

function SearchLab() {
  const [query, setQuery] = useState("A");
  const [resultQuery, setResultQuery] = useState("A");
  const [searching, setSearching] = useState(false);

  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setSearching(true);
  }, []);

  // The lab owns only the controlled-page boundary: new input becomes pending
  // immediately, and the test settles it explicitly like a server response.
  // Request cancellation/race ordering stays covered by the production hooks'
  // Vitest suites; this browser contract proves DataTable never relabels the
  // previous settled rows while their replacement is pending.
  const settleSearch = useCallback(() => {
    setResultQuery(query);
    setSearching(false);
  }, [query]);

  const rows = useMemo(() => {
    const normalized = resultQuery.trim().toLowerCase();
    if (normalized === "a1") return SEARCH_ROWS.filter((row) => row.name.startsWith("A1"));
    if (normalized === "a") return SEARCH_ROWS.filter((row) => row.name.startsWith("A"));
    return SEARCH_ROWS.filter((row) => row.name.toLowerCase().includes(normalized));
  }, [resultQuery]);

  return (
    <main
      data-scenario="search"
      data-query={query}
      data-result-query={resultQuery}
      data-searching={String(searching)}
    >
      <DataTable
        tableId="perf-search"
        rows={rows}
        columns={dataTableColumns}
        getRowKey={(row) => row.id}
        search={{
          value: query,
          onChange: changeQuery,
          debounceMs: 0,
          searching,
          scope: "server",
          totalRecords: rows.length,
        }}
      />
      <button type="button" data-settle-search onClick={settleSearch}>Settle search</button>
    </main>
  );
}

function App() {
  const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "health";
  if (scenario === "data-table-desktop") return <DataTableLab />;
  if (scenario === "data-table-mobile") return <DataTableLab mobile />;
  if (scenario === "data-grid") return <DataGridLab />;
  if (scenario === "mobile-virtual-list") return <MobileVirtualListLab />;
  if (scenario === "search") return <SearchLab />;
  return <main data-scenario="health">ready</main>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
