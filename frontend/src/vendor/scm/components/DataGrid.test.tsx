import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DataGrid, type DataGridColumn } from "./DataGrid";

type Row = { id: string; name: string };
const rows: Row[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "A1" },
];
const columns: DataGridColumn<Row>[] = [
  { key: "name", label: "Name", accessor: (row) => row.name, searchValue: (row) => row.name },
];

afterEach(() => localStorage.clear());

describe("DataGrid search scope", () => {
  test("states that built-in search only covers the loaded rows", () => {
    render(
      <DataGrid
        rows={rows}
        columns={columns}
        storageKey="search-scope-test"
        rowKey={(row) => row.id}
      />,
    );
    expect(screen.getByText("Searches 2 loaded rows only")).toBeTruthy();
  });
});
