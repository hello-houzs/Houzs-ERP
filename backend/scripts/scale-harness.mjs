#!/usr/bin/env node

import Database from "better-sqlite3";
import postgres from "postgres";
import { writeFile } from "node:fs/promises";
import { assertPgTarget } from "./scale-target-guard.mjs";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=", 2);
    return [key, value];
  }),
);

const integerArg = (name, fallback) => {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};

const config = {
  engine: args.get("engine") ?? "sqlite",
  orders: integerArg("orders", 100_000),
  lines: integerArg("lines", 100_000),
  skus: integerArg("skus", 10_000),
  users: integerArg("users", 10_000),
  runs: integerArg("runs", 20),
  json: args.get("json") ?? null,
};

if (!["sqlite", "pg", "both"].includes(config.engine)) {
  throw new Error("--engine must be sqlite, pg, or both");
}

const COMPANY_IDS = [1, 2];
const PAGE_SIZE = 50;
const DEEP_OFFSET = Math.max(0, Math.min(4_950, config.orders - PAGE_SIZE));

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
};

function validateRows(name, rows, expectedRows, validate) {
  if (!Array.isArray(rows)) throw new Error(`${name} did not return a row array`);
  if (rows.length !== expectedRows) {
    throw new Error(`${name} returned ${rows.length} rows; expected ${expectedRows}`);
  }
  validate?.(rows);
}

const validateTenant = (companyId) => (rows) => {
  if (rows.some((row) => Number(row.company_id) !== companyId)) {
    throw new Error(`result leaked outside company ${companyId}`);
  }
};

function validatePagination(first, second) {
  const firstIds = new Set(first.map((row) => String(row.id)));
  if (second.some((row) => firstIds.has(String(row.id)))) {
    throw new Error("pagination returned duplicate rows across adjacent pages");
  }
}

async function measure(name, fn, expectedRows, validate) {
  for (let i = 0; i < 3; i += 1) {
    validateRows(name, await fn(), expectedRows, validate);
  }
  const samples = [];
  for (let i = 0; i < config.runs; i += 1) {
    const started = performance.now();
    const rows = await fn();
    samples.push(performance.now() - started);
    validateRows(name, rows, expectedRows, validate);
  }
  return {
    name,
    rows: expectedRows,
    p50_ms: Number(percentile(samples, 0.5).toFixed(2)),
    p95_ms: Number(percentile(samples, 0.95).toFixed(2)),
    max_ms: Number(Math.max(...samples).toFixed(2)),
  };
}

function sqliteHarness() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");
  db.pragma("temp_store = MEMORY");
  db.exec(`
    CREATE TABLE perf_users (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE perf_skus (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE perf_orders (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      doc_no TEXT NOT NULL,
      doc_date TEXT NOT NULL,
      debtor_name TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE perf_order_lines (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      doc_no TEXT NOT NULL,
      item_code TEXT NOT NULL,
      qty INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX perf_orders_doc_no ON perf_orders(company_id, doc_no);
    CREATE INDEX perf_orders_list ON perf_orders(company_id, doc_date DESC, doc_no DESC);
    CREATE INDEX perf_order_lines_doc ON perf_order_lines(company_id, doc_no);
    CREATE INDEX perf_users_name ON perf_users(company_id, name COLLATE NOCASE);
    CREATE INDEX perf_skus_code ON perf_skus(company_id, code COLLATE NOCASE);
  `);

  const insertUser = db.prepare(
    "INSERT INTO perf_users VALUES (?, ?, ?, ?, 'active')",
  );
  const insertSku = db.prepare(
    "INSERT INTO perf_skus VALUES (?, ?, ?, ?, 'ACTIVE')",
  );
  const insertOrder = db.prepare(
    "INSERT INTO perf_orders VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertLine = db.prepare(
    "INSERT INTO perf_order_lines VALUES (?, ?, ?, ?, ?)",
  );
  const seed = db.transaction(() => {
    for (const companyId of COMPANY_IDS) {
      const userBase = (companyId - 1) * config.users;
      const skuBase = (companyId - 1) * config.skus;
      const orderBase = (companyId - 1) * config.orders;
      const lineBase = (companyId - 1) * config.lines;
      for (let localId = 1; localId <= config.users; localId += 1) {
        insertUser.run(userBase + localId, companyId, `User ${String(localId).padStart(5, "0")}`, `user${localId}@c${companyId}.perf.invalid`);
      }
      for (let localId = 1; localId <= config.skus; localId += 1) {
        insertSku.run(skuBase + localId, companyId, `SKU-${String(localId).padStart(5, "0")}`, `Product ${localId}`);
      }
      for (let localId = 1; localId <= config.orders; localId += 1) {
        const day = String(1 + (localId % 28)).padStart(2, "0");
        const month = String(1 + (Math.floor(localId / 28) % 12)).padStart(2, "0");
        insertOrder.run(
          orderBase + localId,
          companyId,
          `SO-2607-${String(localId).padStart(6, "0")}`,
          `2026-${month}-${day}`,
          `Customer ${localId % 20_000}`,
          ["DRAFT", "CONFIRMED", "IN_PRODUCTION", "DELIVERED"][localId % 4],
          `2026-${month}-${day}T12:00:00Z`,
        );
      }
      for (let localId = 1; localId <= config.lines; localId += 1) {
        const orderId = 1 + ((localId - 1) % config.orders);
        insertLine.run(
          lineBase + localId,
          companyId,
          `SO-2607-${String(orderId).padStart(6, "0")}`,
          `SKU-${String(1 + (localId % config.skus)).padStart(5, "0")}`,
          1 + (localId % 5),
        );
      }
    }
  });
  seed();
  db.exec("ANALYZE");

  const queries = {
    firstPage: db.prepare(
      "SELECT id, company_id, doc_no, doc_date, debtor_name, status FROM perf_orders WHERE company_id = ? ORDER BY doc_date DESC, doc_no DESC LIMIT 50",
    ),
    deepPage: db.prepare(
      `SELECT id, company_id, doc_no, doc_date, debtor_name, status FROM perf_orders WHERE company_id = ? ORDER BY doc_date DESC, doc_no DESC LIMIT 50 OFFSET ${DEEP_OFFSET}`,
    ),
    oneCharPrefix: db.prepare(
      "SELECT id, company_id, doc_no FROM perf_orders WHERE company_id = ? AND doc_no LIKE ? ORDER BY doc_date DESC, doc_no DESC LIMIT 6",
    ),
    detailLines: db.prepare(
      "SELECT id, company_id, item_code, qty FROM perf_order_lines WHERE company_id = ? AND doc_no = ? ORDER BY id",
    ),
    userTypeahead: db.prepare(
      "SELECT id, company_id, name, email FROM perf_users WHERE company_id = ? AND name LIKE ? COLLATE NOCASE ORDER BY name LIMIT 20",
    ),
    skuTypeahead: db.prepare(
      "SELECT id, company_id, code, name FROM perf_skus WHERE company_id = ? AND code LIKE ? COLLATE NOCASE ORDER BY code LIMIT 20",
    ),
  };

  return {
    engine: "sqlite-query-shape",
    counts: {
      per_tenant: { orders: config.orders, lines: config.lines, skus: config.skus, users: config.users },
      total: { orders: config.orders * 2, lines: config.lines * 2, skus: config.skus * 2, users: config.users * 2 },
    },
    plans: {
      first_page: db.prepare("EXPLAIN QUERY PLAN SELECT id, doc_no FROM perf_orders WHERE company_id = 1 ORDER BY doc_date DESC, doc_no DESC LIMIT 50").all(),
      detail_lines: db.prepare("EXPLAIN QUERY PLAN SELECT id FROM perf_order_lines WHERE company_id = 1 AND doc_no = 'SO-2607-000001'").all(),
    },
    correctness() {
      const first = queries.firstPage.all(1);
      const second = db.prepare(
        "SELECT id, company_id, doc_no FROM perf_orders WHERE company_id = ? ORDER BY doc_date DESC, doc_no DESC LIMIT 50 OFFSET 50",
      ).all(1);
      const expectedFirst = Math.min(PAGE_SIZE, config.orders);
      const expectedSecond = Math.min(PAGE_SIZE, Math.max(0, config.orders - PAGE_SIZE));
      validateRows("correctness:first-page", first, expectedFirst, (rows) => {
        if (rows.some((row) => row.company_id !== 1)) throw new Error("first page leaked another tenant");
      });
      validateRows("correctness:second-page", second, expectedSecond, (rows) => {
        if (rows.some((row) => row.company_id !== 1)) throw new Error("second page leaked another tenant");
      });
      validatePagination(first, second);
      const broad = queries.oneCharPrefix.all(1, "S%");
      const narrow = queries.oneCharPrefix.all(1, "SO-2607-000001%");
      if (broad.length !== Math.min(6, config.orders) || broad.some((row) => !row.doc_no.startsWith("S"))) {
        throw new Error("one-character prefix returned an invalid result");
      }
      if (narrow.length !== 1 || narrow[0].doc_no !== "SO-2607-000001" || narrow[0].company_id !== 1) {
        throw new Error("narrow prefix did not retrieve the expected scoped order");
      }
      return { first_page_rows: first.length, second_page_rows: second.length, no_adjacent_duplicates: true, prefix_narrowing: true };
    },
    async benchmarks() {
      const cases = [
        ["orders:first-page", () => queries.firstPage.all(1), Math.min(PAGE_SIZE, config.orders), validateTenant(1)],
        ["orders:deep-offset-page", () => queries.deepPage.all(1), Math.min(PAGE_SIZE, config.orders - DEEP_OFFSET), validateTenant(1)],
        ["orders:one-char-prefix", () => queries.oneCharPrefix.all(1, "S%"), Math.min(6, config.orders), (rows) => {
          validateTenant(1)(rows);
          if (rows.some((row) => !row.doc_no.startsWith("S"))) throw new Error("bad prefix result");
        }],
        ["orders:detail-lines", () => queries.detailLines.all(1, "SO-2607-000001"), Math.floor((config.lines - 1) / config.orders) + 1, validateTenant(1)],
        ["users:typeahead", () => queries.userTypeahead.all(1, "User 0%"), Math.min(20, config.users, 9_999), validateTenant(1)],
        ["skus:typeahead", () => queries.skuTypeahead.all(1, "SKU-0%"), Math.min(20, config.skus, 9_999), validateTenant(1)],
      ];
      const results = [];
      for (const [name, query, expectedRows, validate] of cases) results.push(await measure(name, query, expectedRows, validate));
      return results;
    },
    close: () => db.close(),
  };
}

async function postgresHarness() {
  const url = process.env.PERF_DATABASE_URL;
  if (!url) throw new Error("PERF_DATABASE_URL is required for --engine=pg/both");
  const local = assertPgTarget(url);
  const sql = postgres(url, { ssl: local ? false : "require", max: 1, prepare: false });
  await sql.unsafe("BEGIN");
  try {
    await sql.unsafe(`
      CREATE TEMP TABLE perf_users (id bigint PRIMARY KEY, company_id bigint NOT NULL, name text NOT NULL, email text NOT NULL, status text NOT NULL) ON COMMIT DROP;
      CREATE TEMP TABLE perf_skus (id bigint PRIMARY KEY, company_id bigint NOT NULL, code text NOT NULL, name text NOT NULL, status text NOT NULL) ON COMMIT DROP;
      CREATE TEMP TABLE perf_orders (id bigint PRIMARY KEY, company_id bigint NOT NULL, doc_no text NOT NULL, doc_date date NOT NULL, debtor_name text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL) ON COMMIT DROP;
      CREATE TEMP TABLE perf_order_lines (id bigint PRIMARY KEY, company_id bigint NOT NULL, doc_no text NOT NULL, item_code text NOT NULL, qty integer NOT NULL) ON COMMIT DROP;
      CREATE UNIQUE INDEX perf_orders_doc_no ON perf_orders(company_id, doc_no);
      CREATE INDEX perf_orders_list ON perf_orders(company_id, doc_date DESC, doc_no DESC);
      CREATE INDEX perf_orders_prefix ON perf_orders(company_id, doc_no text_pattern_ops);
      CREATE INDEX perf_order_lines_doc ON perf_order_lines(company_id, doc_no);
      CREATE INDEX perf_users_name ON perf_users(company_id, lower(name) text_pattern_ops);
      CREATE INDEX perf_skus_code ON perf_skus(company_id, lower(code) text_pattern_ops);
      INSERT INTO perf_users SELECT ((company_id - 1) * ${config.users}) + g, company_id, 'User ' || lpad(g::text, 5, '0'), 'user' || g || '@c' || company_id || '.perf.invalid', 'active' FROM generate_series(1, 2) company_id CROSS JOIN generate_series(1, ${config.users}) g;
      INSERT INTO perf_skus SELECT ((company_id - 1) * ${config.skus}) + g, company_id, 'SKU-' || lpad(g::text, 5, '0'), 'Product ' || g, 'ACTIVE' FROM generate_series(1, 2) company_id CROSS JOIN generate_series(1, ${config.skus}) g;
      INSERT INTO perf_orders SELECT ((company_id - 1) * ${config.orders}) + g, company_id, 'SO-2607-' || lpad(g::text, 6, '0'), DATE '2024-01-01' + (g % 730)::integer, 'Customer ' || (g % 20000), (ARRAY['DRAFT','CONFIRMED','IN_PRODUCTION','DELIVERED'])[(1 + (g % 4))::integer], now() - (g % 730) * interval '1 day' FROM generate_series(1, 2) company_id CROSS JOIN generate_series(1, ${config.orders}) g;
      INSERT INTO perf_order_lines SELECT ((company_id - 1) * ${config.lines}) + g, company_id, 'SO-2607-' || lpad((1 + ((g - 1) % ${config.orders}))::text, 6, '0'), 'SKU-' || lpad((1 + (g % ${config.skus}))::text, 5, '0'), 1 + (g % 5) FROM generate_series(1, 2) company_id CROSS JOIN generate_series(1, ${config.lines}) g;
      ANALYZE perf_users; ANALYZE perf_skus; ANALYZE perf_orders; ANALYZE perf_order_lines;
    `);
    const plans = {};
    plans.first_page = await sql.unsafe("EXPLAIN (FORMAT TEXT) SELECT id, doc_no FROM perf_orders WHERE company_id = 1 ORDER BY doc_date DESC, doc_no DESC LIMIT 50");
    plans.detail_lines = await sql.unsafe("EXPLAIN (FORMAT TEXT) SELECT id FROM perf_order_lines WHERE company_id = 2 AND doc_no = 'SO-2607-000001'");
    const first = await sql`SELECT id, company_id, doc_no FROM perf_orders WHERE company_id = 1 ORDER BY doc_date DESC, doc_no DESC LIMIT 50`;
    const second = await sql`SELECT id, company_id, doc_no FROM perf_orders WHERE company_id = 1 ORDER BY doc_date DESC, doc_no DESC LIMIT 50 OFFSET 50`;
    const narrow = await sql`SELECT id, company_id, doc_no FROM perf_orders WHERE company_id = 1 AND doc_no LIKE 'SO-2607-000001%' ORDER BY doc_date DESC, doc_no DESC LIMIT 6`;
    validateRows("correctness:first-page", first, Math.min(PAGE_SIZE, config.orders), validateTenant(1));
    validateRows("correctness:second-page", second, Math.min(PAGE_SIZE, Math.max(0, config.orders - PAGE_SIZE)), validateTenant(1));
    validateRows("correctness:narrow-prefix", narrow, 1, (rows) => {
      validateTenant(1)(rows);
      if (rows[0].doc_no !== "SO-2607-000001") throw new Error("narrow prefix returned the wrong order");
    });
    validatePagination(first, second);
    const correctness = {
      first_page_rows: first.length,
      second_page_rows: second.length,
      no_adjacent_duplicates: true,
      prefix_narrowing: true,
    };
    const cases = [
      ["orders:first-page", () => sql`SELECT id, company_id, doc_no, doc_date, debtor_name, status FROM perf_orders WHERE company_id = 1 ORDER BY doc_date DESC, doc_no DESC LIMIT 50`, Math.min(PAGE_SIZE, config.orders)],
      ["orders:deep-offset-page", () => sql`SELECT id, company_id, doc_no, doc_date, debtor_name, status FROM perf_orders WHERE company_id = 1 ORDER BY doc_date DESC, doc_no DESC LIMIT 50 OFFSET ${DEEP_OFFSET}`, Math.min(PAGE_SIZE, config.orders - DEEP_OFFSET)],
      ["orders:one-char-prefix", () => sql`SELECT id, company_id, doc_no FROM perf_orders WHERE company_id = 1 AND doc_no LIKE 'S%' ORDER BY doc_date DESC, doc_no DESC LIMIT 6`, Math.min(6, config.orders)],
      ["orders:detail-lines", () => sql`SELECT id, company_id, item_code, qty FROM perf_order_lines WHERE company_id = 1 AND doc_no = 'SO-2607-000001' ORDER BY id`, Math.floor((config.lines - 1) / config.orders) + 1],
      ["users:typeahead", () => sql`SELECT id, company_id, name, email FROM perf_users WHERE company_id = 1 AND lower(name) LIKE 'user 0%' ORDER BY name LIMIT 20`, Math.min(20, config.users, 9_999)],
      ["skus:typeahead", () => sql`SELECT id, company_id, code, name FROM perf_skus WHERE company_id = 1 AND lower(code) LIKE 'sku-0%' ORDER BY code LIMIT 20`, Math.min(20, config.skus, 9_999)],
    ];
    const benchmarks = [];
    for (const [name, query, expectedRows] of cases) benchmarks.push(await measure(name, query, expectedRows));
    return {
      engine: "postgres-temp-tables",
      counts: {
        per_tenant: { orders: config.orders, lines: config.lines, skus: config.skus, users: config.users },
        total: { orders: config.orders * 2, lines: config.lines * 2, skus: config.skus * 2, users: config.users * 2 },
      },
      plans,
      correctness,
      benchmarks,
    };
  } finally {
    await sql.unsafe("ROLLBACK").catch(() => undefined);
    await sql.end();
  }
}

const results = [];
if (config.engine === "sqlite" || config.engine === "both") {
  const harness = sqliteHarness();
  try {
    results.push({
      engine: harness.engine,
      counts: harness.counts,
      plans: harness.plans,
      correctness: harness.correctness(),
      benchmarks: await harness.benchmarks(),
    });
  } finally {
    harness.close();
  }
}
if (config.engine === "pg" || config.engine === "both") results.push(await postgresHarness());

const report = { generated_at: new Date().toISOString(), config, results };
console.log(JSON.stringify(report, null, 2));
if (config.json) await writeFile(config.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
