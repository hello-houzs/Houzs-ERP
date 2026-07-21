import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const sourceRoot = path.join(backendRoot, "src");
const repoRoot = path.resolve(backendRoot, "..");
const outputPath = path.join(repoRoot, "docs", "generated", "route-capability-matrix.csv");
const summaryPath = path.join(repoRoot, "docs", "generated", "route-capability-summary.md");
const manualRoutesPath = path.join(scriptDir, "route-capability-manual.json");
const duplicateAllowlistPath = path.join(scriptDir, "route-capability-duplicate-allowlist.json");
const checkOnly = process.argv.includes("--check");
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

function parse(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return {
    filePath,
    text,
    source: ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

function literalText(node) {
  return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

function normalizePath(...parts) {
  const joined = parts
    .filter(Boolean)
    .join("/")
    .replaceAll(/\/{2,}/g, "/")
    .replace(/\/\*$/, "/*");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function pathHasPrefix(value, prefix) {
  const normalizedPrefix = prefix.replace(/\/$/, "");
  return value === normalizedPrefix || value.startsWith(`${normalizedPrefix}/`);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function relativeFile(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function printCompact(node, source) {
  return node.getText(source).replaceAll(/\s+/g, " ").trim();
}

function gateFromArgs(args, source) {
  const gates = args
    .map((arg) => printCompact(arg, source))
    .filter((text) => /(require|permission|guard|auth|owner|director|caseTrack|supplierTrack)/i.test(text));
  return gates.join(" + ");
}

function hasCapabilityGate(text) {
  return /(requirePermission|requireAnyPermission|requirePageAccess|requireScmAccess|scmAreaGuard|permissionOr|owner|director)/i.test(text);
}

function handlerGuard(handler, source) {
  const text = handler ? printCompact(handler, source) : "";
  const matches = text.match(/\b(?:mirrorAuthed|verifyPassword|verify[A-Z][A-Za-z]*(?:Token|Secret|Signature)|validate[A-Z][A-Za-z]*(?:Token|Secret|Signature))\b/g) ?? [];
  return [...new Set(matches)].join(" + ");
}

function resolveRelativeImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

const manualRoutes = JSON.parse(fs.readFileSync(manualRoutesPath, "utf8"));
const manualRoutesByKey = new Map();
for (const entry of manualRoutes) {
  const key = `${entry.source}::${String(entry.method).toUpperCase()}::${entry.expression}`;
  if (manualRoutesByKey.has(key)) throw new Error(`Duplicate manual route expansion: ${key}`);
  if (!Array.isArray(entry.paths) || entry.paths.length === 0) throw new Error(`Manual route expansion has no paths: ${key}`);
  if (entry.paths.some((routePath) => typeof routePath !== "string" || !routePath.startsWith("/"))) {
    throw new Error(`Manual route expansion contains an invalid path: ${key}`);
  }
  if (new Set(entry.paths).size !== entry.paths.length) throw new Error(`Manual route expansion contains duplicates: ${key}`);
  manualRoutesByKey.set(key, entry.paths);
}
const consumedManualRoutes = new Set();
const sourceValidatedManualRoutes = new Set();

const duplicateAllowlist = JSON.parse(fs.readFileSync(duplicateAllowlistPath, "utf8"));
const duplicateAllowlistByKey = new Map();
for (const entry of duplicateAllowlist) {
  const key = `${String(entry.method).toUpperCase()} ${entry.path}`;
  if (duplicateAllowlistByKey.has(key)) throw new Error(`Duplicate route allowlist entry: ${key}`);
  if (!Array.isArray(entry.sources) || entry.sources.length < 2) throw new Error(`Duplicate route allowlist entry needs at least two sources: ${key}`);
  duplicateAllowlistByKey.set(key, [...entry.sources].sort());
}

function importMap(parsed) {
  const imports = new Map();
  for (const statement of parsed.source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const specifier = literalText(statement.moduleSpecifier);
    if (!specifier?.startsWith(".")) continue;
    const resolved = resolveRelativeImport(parsed.filePath, specifier);
    const clause = statement.importClause;
    if (clause.name) imports.set(clause.name.text, { filePath: resolved, exportName: "default", specifier });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          filePath: resolved,
          exportName: element.propertyName?.text ?? element.name.text,
          specifier,
        });
      }
    }
  }
  return imports;
}

function registrations(parsed, rootPrefix) {
  const imports = importMap(parsed);
  const registrations = [];
  const mountedUses = [];
  let authLine = Number.POSITIVE_INFINITY;
  let companyLine = Number.POSITIVE_INFINITY;

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(parsed.source);
      const method = node.expression.name.text;
      const first = node.arguments[0] && literalText(node.arguments[0]);
      const line = parsed.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

      if (owner === "app" && method === "use" && first === "/api/*") {
        const middleware = node.arguments[1]?.getText(parsed.source) ?? "";
        if (middleware === "auth") authLine = line;
        if (middleware === "companyContext") companyLine = line;
      }

      if ((owner === "app" || owner === "scm") && method === "use" && first) {
        mountedUses.push({
          prefix: normalizePath(rootPrefix, first.replace(/\/\*$/, "")),
          gate: gateFromArgs(node.arguments.slice(1), parsed.source),
          line,
        });
      }

      if ((owner === "app" || owner === "scm") && method === "route") {
        if (first == null) {
          const expression = node.arguments[0] ? printCompact(node.arguments[0], parsed.source) : "<missing>";
          throw new Error(`Dynamic router mount requires an explicit parser ${relativeFile(parsed.filePath)}:${line}: ${owner}.route(${expression}, ...)`);
        }
        const router = node.arguments[1]?.getText(parsed.source);
        const imported = router ? imports.get(router) : null;
        if (!router || !imported) {
          throw new Error(`Unresolved router registration ${relativeFile(parsed.filePath)}:${line}: ${owner}.route(${first}, ${router ?? "missing"})`);
        }
        if (!imported.filePath) {
          throw new Error(`Unresolved route import ${relativeFile(parsed.filePath)}:${line}: ${router} from ${imported.specifier}`);
        }
        registrations.push({
          key: `${path.normalize(imported.filePath)}::${router}`,
          filePath: path.normalize(imported.filePath),
          importName: router,
          exportName: imported.exportName,
          prefix: normalizePath(rootPrefix, first),
          line,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed.source);
  return { registrations, mountedUses, authLine, companyLine };
}

function declaredRouterNames(parsed) {
  const names = new Set();
  for (const statement of parsed.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

function defaultExportName(parsed) {
  for (const statement of parsed.source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      return statement.expression.text;
    }
  }
  return null;
}

const rootIndex = parse(path.join(sourceRoot, "index.ts"));
const scmIndex = parse(path.join(sourceRoot, "scm", "index.ts"));
const root = registrations(rootIndex, "");
const scmRootRegistration = root.registrations.find((entry) => entry.filePath === path.normalize(scmIndex.filePath));
if (!scmRootRegistration) throw new Error("Root SCM router registration was not resolved");
const scm = registrations(scmIndex, scmRootRegistration.prefix);
const scmRootMountLine = scmRootRegistration.line;
const allRegistrations = [...root.registrations, ...scm.registrations];
const registrationsByFile = new Map();
for (const registration of allRegistrations) {
  const list = registrationsByFile.get(registration.filePath) ?? [];
  list.push(registration);
  registrationsByFile.set(registration.filePath, list);
}

const rows = [];
const coveredRegistrations = new Set();
const routeFiles = [path.join(sourceRoot, "routes"), path.join(sourceRoot, "scm", "routes")]
  .flatMap(walk)
  .map(parse);

function assertSamePaths(label, actual, expected) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} expansion drifted. Manual=${actualSorted.join(",")} Source=${expectedSorted.join(",")}`);
  }
}

function verifyKnownDynamicFactories() {
  const agentSource = routeFiles.find((parsed) => relativeFile(parsed.filePath) === "backend/src/routes/agent-console.ts");
  const outstandingSource = routeFiles.find((parsed) => relativeFile(parsed.filePath) === "backend/src/scm/routes/outstanding.ts");
  if (!agentSource || !outstandingSource) throw new Error("Known dynamic route sources are missing");

  const bases = [];
  function collectAgentBases(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "mountEngineRoutes") {
      const options = node.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options)) throw new Error("mountEngineRoutes requires a literal options object for route audit");
      const baseProperty = options.properties.find((property) =>
        ts.isPropertyAssignment(property) && property.name.getText(agentSource.source).replaceAll(/[\"']/g, "") === "base"
      );
      const base = baseProperty && ts.isPropertyAssignment(baseProperty) ? literalText(baseProperty.initializer) : null;
      if (!base) throw new Error("mountEngineRoutes requires a literal base for route audit");
      bases.push(base);
    }
    ts.forEachChild(node, collectAgentBases);
  }
  collectAgentBases(agentSource.source);
  if (bases.length === 0) throw new Error("No mountEngineRoutes calls found for route audit");
  const agentExpressions = ["status", "proposals", "proposals/decide", "brief"];
  for (const suffix of agentExpressions) {
    const method = suffix === "proposals/decide" ? "POST" : "GET";
    const expression = `\`/\${base}/${suffix}\``;
    const key = `backend/src/routes/agent-console.ts::${method}::${expression}`;
    const manual = manualRoutesByKey.get(key);
    if (!manual) throw new Error(`Missing known agent-console expansion: ${key}`);
    assertSamePaths(key, manual, bases.map((base) => `/${base}/${suffix}`));
    sourceValidatedManualRoutes.add(key);
  }

  const slugs = [];
  function collectOutstandingSlugs(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "MODULES") {
      if (!node.initializer || !ts.isObjectLiteralExpression(node.initializer)) throw new Error("Outstanding MODULES must remain a literal object for route audit");
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property)) throw new Error("Outstanding MODULES contains a non-literal property");
        slugs.push(property.name.getText(outstandingSource.source).replaceAll(/[\"']/g, ""));
      }
    }
    ts.forEachChild(node, collectOutstandingSlugs);
  }
  collectOutstandingSlugs(outstandingSource.source);
  if (slugs.length === 0) throw new Error("Outstanding MODULES entries are missing");
  const outstandingKey = "backend/src/scm/routes/outstanding.ts::GET::`/${slug}`";
  const manualOutstanding = manualRoutesByKey.get(outstandingKey);
  if (!manualOutstanding) throw new Error(`Missing known outstanding expansion: ${outstandingKey}`);
  assertSamePaths(outstandingKey, manualOutstanding, slugs.map((slug) => `/${slug}`));
  sourceValidatedManualRoutes.add(outstandingKey);
}

verifyKnownDynamicFactories();
const unvalidatedManualRoutes = [...manualRoutesByKey.keys()].filter((key) => !sourceValidatedManualRoutes.has(key));
if (unvalidatedManualRoutes.length > 0) {
  throw new Error(`Manual dynamic routes require source validators:\n${unvalidatedManualRoutes.join("\n")}`);
}

for (const parsed of routeFiles) {
  const fileRegistrations = registrationsByFile.get(path.normalize(parsed.filePath)) ?? [];
  if (fileRegistrations.length === 0) continue;
  const routerNames = declaredRouterNames(parsed);
  const defaultRouter = defaultExportName(parsed);
  const fileUses = [];

  function collectUses(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "use" &&
      ts.isIdentifier(node.expression.expression) &&
      routerNames.has(node.expression.expression.text)
    ) {
      const prefix = literalText(node.arguments[0]);
      if (prefix) {
        const line = parsed.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        fileUses.push({
          router: node.expression.expression.text,
          prefix,
          gate: gateFromArgs(node.arguments.slice(1), parsed.source),
          line,
        });
      }
    }
    ts.forEachChild(node, collectUses);
  }
  collectUses(parsed.source);

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP_METHODS.has(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const router = node.expression.expression.text;
      const registrationsForRouter = fileRegistrations.filter((entry) =>
        (entry.exportName === "default" ? defaultRouter : entry.exportName) === router
      );
      if (registrationsForRouter.length > 0) {
        const method = node.expression.name.text.toUpperCase();
        const line = parsed.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const routeArgument = node.arguments[0];
        const literalRoutePath = routeArgument && literalText(routeArgument);
        let routePaths;
        if (literalRoutePath !== null && literalRoutePath !== undefined) {
          routePaths = [literalRoutePath];
        } else {
          const expression = routeArgument ? printCompact(routeArgument, parsed.source) : "<missing>";
          const key = `${relativeFile(parsed.filePath)}::${method}::${expression}`;
          routePaths = manualRoutesByKey.get(key);
          if (!routePaths) {
            throw new Error(`Dynamic mounted route requires an explicit expansion ${relativeFile(parsed.filePath)}:${line}: ${method} ${expression}`);
          }
          consumedManualRoutes.add(key);
        }

        for (const routePath of routePaths) {
          for (const registration of registrationsForRouter) {
            coveredRegistrations.add(registration.key);
            const fullPath = normalizePath(registration.prefix, routePath === "/" ? "" : routePath);
            const isScm = fullPath.startsWith("/api/scm/");
            const directGate = gateFromArgs(node.arguments.slice(1, -1), parsed.source);
            const inHandlerGuard = handlerGuard(node.arguments.at(-1), parsed.source);
            const localGate = fileUses
              .filter((entry) => entry.line < line && entry.router === router && (entry.prefix === "*" || pathHasPrefix(routePath, entry.prefix.replace(/\/\*$/, ""))))
              .map((entry) => entry.gate)
              .filter(Boolean)
              .join(" + ");
            const applicableMountUses = isScm
              ? [
                  ...root.mountedUses.filter((entry) => entry.line < scmRootMountLine),
                  ...scm.mountedUses.filter((entry) => entry.line < registration.line),
                ]
              : root.mountedUses.filter((entry) => entry.line < registration.line);
            const mountGate = applicableMountUses
              .filter((entry) => pathHasPrefix(fullPath, entry.prefix))
              .map((entry) => entry.gate)
              .filter(Boolean)
              .join(" + ");
            const allGates = [mountGate, localGate, directGate].filter(Boolean).join(" + ");
            const routeMiddleware = allGates;
            const auth = registration.line > root.authLine || isScm || /\b(?:auth|caseTrack|supplierTrack)\b/.test(routeMiddleware)
              ? "AUTHENTICATED_MIDDLEWARE"
              : inHandlerGuard
                ? "HANDLER_CREDENTIAL_REVIEW"
                : "NO_STATIC_AUTH_GATE";
            const company = registration.line > root.companyLine || isScm || /\bcompanyContext\b/.test(routeMiddleware)
              ? "COMPANY_CONTEXT"
              : "NO_GLOBAL_COMPANY_CONTEXT";
            const mutation = MUTATION_METHODS.has(method);
            const hasCapability = hasCapabilityGate(allGates);
            const reviewState = mutation && !hasCapability
              ? inHandlerGuard
                ? "HANDLER_GUARD_REVIEW"
                : "MUTATION_INHERITED_ONLY"
              : !hasCapability
                ? "INHERITED_ONLY"
                : "DECLARED_GATE";
            rows.push({
              method,
              path: fullPath,
              auth,
              company,
              mountGate,
              localGate,
              directGate,
              handlerGuard: inHandlerGuard,
              mutation: mutation ? "YES" : "NO",
              reviewState,
              source: `${relativeFile(parsed.filePath)}:${line}`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed.source);
}

const unusedManualRoutes = [...manualRoutesByKey.keys()].filter((key) => !consumedManualRoutes.has(key));
if (unusedManualRoutes.length > 0) {
  throw new Error(`Manual route expansions no longer match mounted dynamic routes:\n${unusedManualRoutes.join("\n")}`);
}

const routeDirectoryMarker = `${path.sep}routes${path.sep}`;
const uncoveredRegistrations = allRegistrations.filter((entry) =>
  entry.filePath.includes(routeDirectoryMarker) && !coveredRegistrations.has(entry.key)
);
if (uncoveredRegistrations.length > 0) {
  const details = uncoveredRegistrations
    .map((entry) => `${relativeFile(entry.filePath)} mounted at ${entry.prefix} as ${entry.importName}`)
    .join("\n");
  throw new Error(`Mounted routers produced no static route rows:\n${details}`);
}

const sentinelRoutes = [
  ["POST", "/api/auth/login"],
  ["GET", "/api/projects"],
  ["POST", "/api/sync/so-mirror"],
  ["GET", "/api/scm/mfg-sales-orders"],
  ["GET", "/api/agents/collection/status"],
  ["POST", "/api/agents/pms/proposals/decide"],
  ["GET", "/api/scm/outstanding/po"],
  ["GET", "/api/scm/outstanding/si"],
];
for (const [method, routePath] of sentinelRoutes) {
  if (!rows.some((row) => row.method === method && row.path === routePath)) {
    throw new Error(`Route inventory parser lost sentinel ${method} ${routePath}`);
  }
}

const preUseSentinels = [
  ["GET", "/api/scm/categories/:id/hero-blob"],
  ["GET", "/api/scm/product-models/:id/photo/:key"],
  ["GET", "/api/scm/product-models/:id/photo-gallery/:key"],
  ["GET", "/api/scm/maintenance-config/sofa-compartments/:code/photo/:key"],
];
for (const [method, routePath] of preUseSentinels) {
  const row = rows.find((candidate) => candidate.method === method && candidate.path === routePath);
  if (!row) throw new Error(`Route inventory parser lost pre-use sentinel ${method} ${routePath}`);
  if (row.localGate) throw new Error(`Router middleware was retroactively applied to ${method} ${routePath}: ${row.localGate}`);
}
const postUseSentinel = rows.find((row) => row.method === "POST" && row.path === "/api/scm/product-models");
if (!postUseSentinel?.localGate.includes("supabaseAuth")) {
  throw new Error("Router middleware ordering sentinel lost supabaseAuth after productModels.use()");
}
if (pathHasPrefix("/api/foo", "/api/foobar") || !pathHasPrefix("/api/foo/bar", "/api/foo")) {
  throw new Error("Segment-aware prefix matching regression");
}

const rowIdentities = new Set();
for (const row of rows) {
  const identity = `${row.method}\u0000${row.path}\u0000${row.source}`;
  if (rowIdentities.has(identity)) throw new Error(`Duplicate route inventory row: ${row.method} ${row.path} ${row.source}`);
  rowIdentities.add(identity);
}

const routeDeclarations = new Map();
for (const row of rows) {
  const key = `${row.method} ${row.path}`;
  const sources = routeDeclarations.get(key) ?? [];
  sources.push(row.source);
  routeDeclarations.set(key, sources);
}
const duplicateDeclarations = [...routeDeclarations.entries()].filter(([, sources]) => sources.length > 1);
const consumedDuplicateAllowlist = new Set();
for (const [key, sources] of duplicateDeclarations) {
  const expectedSources = duplicateAllowlistByKey.get(key);
  if (!expectedSources) throw new Error(`Unreviewed duplicate route declaration: ${key} at ${sources.join(", ")}`);
  assertSamePaths(`Duplicate route ${key}`, sources, expectedSources);
  consumedDuplicateAllowlist.add(key);
}
const staleDuplicateAllowlist = [...duplicateAllowlistByKey.keys()].filter((key) => !consumedDuplicateAllowlist.has(key));
if (staleDuplicateAllowlist.length > 0) {
  throw new Error(`Duplicate route allowlist is stale; remove resolved entries:\n${staleDuplicateAllowlist.join("\n")}`);
}

// Never use localeCompare for a checked-in artifact: Node's ICU locale can
// differ between Windows development and Ubuntu Actions. JS relational string
// comparison is defined by UTF-16 code units and is stable across runtimes.
rows.sort((a, b) =>
  compareCodePoints(a.path, b.path)
  || compareCodePoints(a.method, b.method)
  || compareCodePoints(a.source, b.source)
);
const headers = [
  "method",
  "path",
  "auth_boundary",
  "company_boundary",
  "mount_gate",
  "router_gate",
  "direct_gate",
  "handler_guard",
  "mutation",
  "review_state",
  "source",
];
const body = [
  headers.join(","),
  ...rows.map((row) => [
    row.method,
    row.path,
    row.auth,
    row.company,
    row.mountGate,
    row.localGate,
    row.directGate,
    row.handlerGuard,
    row.mutation,
    row.reviewState,
    row.source,
  ].map(csv).join(",")),
  "",
].join("\n");

const counts = {
  total: rows.length,
  declaredGate: rows.filter((row) => row.reviewState === "DECLARED_GATE").length,
  mutationReview: rows.filter((row) => row.mutation === "YES" && row.reviewState !== "DECLARED_GATE").length,
  readReview: rows.filter((row) => row.mutation === "NO" && row.reviewState !== "DECLARED_GATE").length,
  noStaticAuth: rows.filter((row) => row.auth === "NO_STATIC_AUTH_GATE").length,
  handlerCredentialReview: rows.filter((row) => row.auth === "HANDLER_CREDENTIAL_REVIEW").length,
  duplicateDeclarations: duplicateDeclarations.length,
};
const summaryBody = [
  "# Generated route capability summary",
  "",
  "> Generated by `backend/scripts/generate-route-capability-matrix.mjs`; do not edit manually.",
  "",
  `- Total route rows: ${counts.total}`,
  `- Routes with a declared capability/area gate: ${counts.declaredGate}`,
  `- Mutation routes requiring manual capability classification: ${counts.mutationReview}`,
  `- Read routes requiring manual capability classification: ${counts.readReview}`,
  `- Routes with no static authentication gate: ${counts.noStaticAuth}`,
  `- Routes with a handler-local credential guard: ${counts.handlerCredentialReview}`,
  `- Allowlisted duplicate method/path registrations requiring removal: ${counts.duplicateDeclarations}`,
  "",
].join("\n");

if (checkOnly) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== body) {
    console.error(`Route capability matrix is stale. Run: node backend/scripts/generate-route-capability-matrix.mjs`);
    process.exit(1);
  }
  if (!fs.existsSync(summaryPath) || fs.readFileSync(summaryPath, "utf8") !== summaryBody) {
    console.error(`Route capability summary is stale. Run: node backend/scripts/generate-route-capability-matrix.mjs`);
    process.exit(1);
  }
  console.log(`Route capability matrix is current (${rows.length} routes).`);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, body);
  fs.writeFileSync(summaryPath, summaryBody);
  console.log(`Wrote ${rows.length} routes to ${path.relative(repoRoot, outputPath)}`);
}
