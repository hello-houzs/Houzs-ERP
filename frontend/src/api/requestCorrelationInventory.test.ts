import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

type InventoryEntry = { kind: "transport" | "static-asset"; reason: string };

// Deliberately tiny. API traffic must go through correlatedFetch; the only raw
// fetch exemptions are non-API static assets where adding X-Request-Id could
// create a cross-origin preflight. Any new call site makes this gate fail until
// it is either routed through the transport or explicitly justified here.
const RAW_FETCH_INVENTORY: Record<string, InventoryEntry> = {
  "lib/requestCorrelation.ts": {
    kind: "transport",
    reason: "the single primitive that stamps and retains request ids",
  },
  "hooks/useVersionCheck.ts": {
    kind: "static-asset",
    reason: "same-origin index.html service-worker version probe",
  },
  "vendor/scm/lib/pdf-common.ts": {
    kind: "static-asset",
    reason: "bundled font asset fetch; may be cross-origin and is not an API request",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function hasRawFetch(path: string): boolean {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === "fetch")
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch")
      ) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("request correlation transport inventory", () => {
  test("every raw fetch is the shared transport or an explicit static-asset exemption", () => {
    const src = resolve(process.cwd(), "src");
    const actual = sourceFiles(src)
      .filter(hasRawFetch)
      .map((path) => relative(src, path).replaceAll("\\", "/"))
      .sort();

    expect(actual).toEqual(Object.keys(RAW_FETCH_INVENTORY).sort());
  });

  test("static exemptions cannot silently become API calls", () => {
    for (const [path, entry] of Object.entries(RAW_FETCH_INVENTORY)) {
      if (entry.kind !== "static-asset") continue;
      expect(readFileSync(resolve(process.cwd(), "src", path), "utf8")).not.toMatch(
        /fetch\s*\([^)]*(?:\/api\/|API_URL|VITE_API_URL)/,
      );
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
