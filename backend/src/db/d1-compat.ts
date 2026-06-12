// ---------------------------------------------------------------------------
// D1-compatibility shim over postgres.js.
//
// The backend has ~685 call sites using the D1 surface:
//     env.DB.prepare(sql).bind(...args).all() / .first() / .run()
// Rewriting all of them to postgres.js tagged templates in one pass is high
// risk. This shim exposes the same surface backed by Postgres, so the call
// sites keep their shape. It removes the mechanical churn (the `?` -> `$n`
// placeholder rewrite and the D1 result-shape) for ALL 685, leaving only the
// genuine dialect edits that must be done per query by hand:
//
//   * datetime('now')        -> now()                (86 lines)
//   * INSERT OR REPLACE      -> INSERT ... ON CONFLICT DO UPDATE   (8)
//   * .run() + last_row_id   -> rewrite to `RETURNING id` + .first()  (37)
//
// The shim CANNOT infer those — Postgres has no implicit rowid, and
// ON CONFLICT needs the conflict target. Convert those sites explicitly.
//
// Wiring (Phase 3): build `env.DB` from a per-request Postgres client so the
// existing `env.DB.prepare(...)` keeps working:
//     import { getSql } from "./pg";
//     import { d1Compat } from "./d1-compat";
//     const DB = d1Compat(getSql(resolveDatabaseUrl(env)));
//
// Keep this until routes are migrated. New code should prefer Drizzle
// (getDb) or postgres.js (getSql) directly — do not add new callers here.
// ---------------------------------------------------------------------------
import type { Sql } from "postgres";

/**
 * Rewrite SQLite `?` positional placeholders to Postgres `$1,$2,...`.
 * Quote-aware: `?` inside single-quoted string literals is left alone, so a
 * literal `'a?b'` is not mangled. Postgres `$n` are 1-based.
 */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "?" && !inSingle && !inDouble) {
      out += "$" + ++n;
    } else {
      out += ch;
    }
  }
  return out;
}

// Rewrite the handful of SQLite-isms that appear in raw query TEXT so the
// ~685 call sites keep working unchanged. Quote-aware: never touches data
// inside string literals.
//   datetime('now')  -> to_char(timezone('UTC',now()),'YYYY-MM-DD HH24:MI:SS')
//                       (TEXT columns; same 'YYYY-MM-DD HH:MM:SS' shape)
//   char(            -> chr(   (Postgres spells the codepoint fn chr())
// NOT handled (must be fixed per query — few sites): INSERT OR REPLACE
// (needs an ON CONFLICT target) and reads of meta.last_row_id (need RETURNING).
export function rewriteDialect(sql: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (inStr && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inStr = !inStr;
      out += c;
      continue;
    }
    if (!inStr) {
      const rest = sql.slice(i);
      const dt = rest.match(/^datetime\(\s*'now'\s*\)/i);
      if (dt) {
        out += "to_char(timezone('UTC',now()),'YYYY-MM-DD HH24:MI:SS')";
        i += dt[0].length - 1;
        continue;
      }
      if (rest.slice(0, 5).toLowerCase() === "char(") {
        out += "chr(";
        i += 4;
        continue;
      }
    }
    out += c;
  }
  return out;
}

// D1 row shapes the call sites expect back.
type D1Meta = {
  changes: number;
  last_row_id: number | null;
  rows_read?: number;
  rows_written?: number;
};
type D1Result<T> = { results: T[]; success: true; meta: D1Meta };

/** One prepared (sql + bound args) statement, executed lazily. */
class PreparedStatement {
  private args: unknown[] = [];
  constructor(
    private readonly sql: Sql,
    private readonly query: string,
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  private exec<T = Record<string, unknown>>(): Promise<T[]> {
    // postgres.js `unsafe` runs a dynamic string with positional params.
    // prepare:false is already set on the client (transaction pooler).
    return this.sql.unsafe(
      toPgPlaceholders(rewriteDialect(this.query)),
      this.args as never[],
    ) as unknown as Promise<T[]>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = await this.exec<T>();
    return {
      results: rows,
      success: true,
      meta: { changes: rows.length, last_row_id: null },
    };
  }

  async first<T = Record<string, unknown>>(
    column?: string,
  ): Promise<T | null> {
    const rows = await this.exec<Record<string, unknown>>();
    const row = rows[0] ?? null;
    if (row == null) return null;
    return (column ? (row[column] as T) : (row as T));
  }

  async run(): Promise<{ success: true; meta: D1Meta }> {
    // NOTE: last_row_id is always null here — Postgres has no implicit rowid.
    // Any call site that read meta.last_row_id MUST be converted to append
    // `RETURNING id` and read it via .first("id"). See header (37 sites).
    const rows = await this.exec();
    return {
      success: true,
      meta: { changes: rows.length, last_row_id: null },
    };
  }
}

export interface D1Like {
  prepare(query: string): PreparedStatement;
  batch(statements: PreparedStatement[]): Promise<unknown[]>;
}

/** Wrap a postgres.js client in the D1 surface the routes already use. */
export function d1Compat(sql: Sql): D1Like {
  return {
    prepare: (query: string) => new PreparedStatement(sql, query),
    batch: (statements: PreparedStatement[]) =>
      sql.begin((tx) =>
        Promise.all(
          statements.map((s) =>
            (s as unknown as { exec(): Promise<unknown> }).exec(),
          ),
        ),
      ) as unknown as Promise<unknown[]>,
  };
}
