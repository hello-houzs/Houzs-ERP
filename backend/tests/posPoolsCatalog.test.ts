import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  mfgCatalogHandler,
  productSizeVariantsHandler,
  MFG_CATALOG_COLS,
} from '../src/scm/routes/pos-pools';

/* ────────────────────────────────────────────────────────────────────────────
   /pos-pools — the 2990 POS repoint catalog seam.

   Drives the EXPORTED handlers on a bare Hono app whose middleware injects a
   fake scm supabase + the active companyId (supabaseAuth can't run in the
   harness — same approach as productPickerCompanyScope.test.ts). Pins the four
   claims that matter for a money-facing POS endpoint:
     (a) company isolation both directions,
     (b) the spine filters pos_active but the id/modelId variants must NOT filter
         status/pos_active (a discontinued-but-still-listed sibling has to
         survive so the size picker keeps every size),
     (c) COST never ships — the projection excludes cost columns and the
         per-height cost (seat_height_prices[].priceSen) is stripped,
     (d) the legacy pools map to camelCase and stay company-scoped.
   ──────────────────────────────────────────────────────────────────────────── */

// ── Fake PostgREST query builder — records predicates, applies to canned rows ──
class FakeQuery {
  private preds: Array<(r: Record<string, unknown>) => boolean> = [];
  private _range: [number, number] | null = null;
  constructor(private rows: Array<Record<string, unknown>>) {}
  select() { return this; }
  order() { return this; }
  or() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.preds.push((r) => r[col] != null);
    return this;
  }
  private apply() {
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this._range) out = out.slice(this._range[0], this._range[1] + 1);
    return out;
  }
  range(from: number, to: number) { this._range = [from, to]; return this; }
  then(res: (v: { data: unknown[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve({ data: this.apply(), error: null as null }).then(res, rej);
  }
}

type DataSet = Record<string, Array<Record<string, unknown>>>;
function fakeSupabase(data: DataSet) {
  return { from: (table: string) => new FakeQuery(data[table] ?? []) };
}

function fixture(): DataSet {
  return {
    mfg_products: [
      // company 1 (Houzs) — must never leak into a company-2 read
      { id: 'h1', code: 'H-1', name: 'Houzs A', category: 'SOFA', status: 'ACTIVE', pos_active: true, company_id: 1, model_id: 'hm1', base_model: 'HB1', sell_price_sen: 100000 },
      // company 2 (2990) — the pos_active spine member, carries the embed + seat heights
      {
        id: 'x1', code: 'X-1', name: '2990 A', category: 'SOFA', status: 'ACTIVE', pos_active: true, company_id: 2,
        model_id: 'xm1', base_model: 'XB1', sell_price_sen: 200000, pwp_price_sen: 180000, retail_product_id: null,
        seat_height_prices: [{ height: 'S', priceSen: 50000, sellingPriceSen: 70000, tier: 'PRICE_1' }],
        product_models: { id: 'xm1', name: 'XM One', model_code: 'XM1', photo_url: '/product-models/xm1/photo/k.jpg', active: true, allowed_options: { sizes: ['Q'] } },
      },
      // company 2 — ACTIVE but pos_active=false (excluded from spine, kept by modelId)
      { id: 'x2', code: 'X-2', name: '2990 hidden', category: 'SOFA', status: 'ACTIVE', pos_active: false, company_id: 2, model_id: 'xm1', base_model: 'XB1', sell_price_sen: 210000 },
      // company 2 — DISCONTINUED + pos_active=false sibling. Excluded from spine;
      // MUST be returned by ?id / ?modelId (no status/pos_active filter there).
      { id: 'x3', code: 'X-3', name: '2990 discontinued', category: 'SOFA', status: 'INACTIVE', pos_active: false, company_id: 2, model_id: 'xm1', base_model: 'XB1', sell_price_sen: 205000 },
    ],
    product_size_variants: [
      { product_id: 'p1', size_id: 'queen', active: true, price: 1500, company_id: 2 },
      { product_id: 'p1', size_id: 'king', active: false, price: 1800, company_id: 2 },
      // other company's variant for the same productId — must not leak
      { product_id: 'p1', size_id: 'queen', active: true, price: 9999, company_id: 1 },
    ],
  };
}

function appFor(companyId: number | null, handler: (c: never) => unknown, path: string) {
  const supabase = fakeSupabase(fixture());
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, supabase as never);
    if (companyId !== null) {
      c.set('companyId' as never, companyId as never);
      c.set('allowedCompanyIds' as never, [1, 2] as never);
    }
    await next();
  });
  app.get(path, handler as never);
  return app;
}

type CatalogRow = { id: string; code: string; seat_height_prices?: unknown; product_models?: unknown };
async function catalog(companyId: number | null, query = ''): Promise<{ rows: CatalogRow[]; res: Response }> {
  const res = await appFor(companyId, mfgCatalogHandler, '/mfg-catalog').request('/mfg-catalog' + query);
  const body = (await res.clone().json()) as { products: CatalogRow[] };
  return { rows: body.products, res };
}

describe('GET /pos-pools/mfg-catalog — spine: company isolation + pos_active gate', () => {
  test('company 2 spine sees ONLY its own pos_active SKUs — not company 1, not the hidden/discontinued siblings', async () => {
    const { rows } = await catalog(2);
    expect(rows.map((r) => r.code).sort()).toEqual(['X-1']);
  });

  test('company 1 spine sees ONLY company 1 — the other direction', async () => {
    const { rows } = await catalog(1);
    expect(rows.map((r) => r.code).sort()).toEqual(['H-1']);
    expect(rows.some((r) => r.code.startsWith('X-'))).toBe(false);
  });

  test('Vary + private cache headers are set so a company switch cannot serve a stale catalogue', async () => {
    const { res } = await catalog(2);
    expect(res.headers.get('vary')).toBe('X-Company-Id');
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
  });
});

describe('GET /pos-pools/mfg-catalog — id/modelId variants keep discontinued siblings (HARD RULE)', () => {
  test('?id= returns a pos_active=false / INACTIVE row (no status/pos_active filter on the id variant)', async () => {
    const { rows } = await catalog(2, '?id=x3');
    expect(rows.map((r) => r.code)).toEqual(['X-3']);
  });

  test('?modelId= returns ALL siblings of the model incl. hidden + discontinued, company-scoped', async () => {
    const { rows } = await catalog(2, '?modelId=xm1');
    expect(rows.map((r) => r.code).sort()).toEqual(['X-1', 'X-2', 'X-3']);
  });

  test('?modelId= is still company-scoped — company 1 gets none of company 2 model xm1', async () => {
    const { rows } = await catalog(1, '?modelId=xm1');
    expect(rows).toEqual([]);
  });
});

describe('GET /pos-pools/mfg-catalog — cost never ships (#625)', () => {
  test('the projection excludes cost columns and includes the selling ones', () => {
    for (const cost of ['cost_price_sen', 'base_price_sen', 'price1_sen']) {
      expect(MFG_CATALOG_COLS).not.toContain(cost);
    }
    for (const sell of ['sell_price_sen', 'pwp_price_sen', 'retail_product_id', 'product_models']) {
      expect(MFG_CATALOG_COLS).toContain(sell);
    }
  });

  test('seat_height_prices strips the per-height COST (priceSen) but keeps sellingPriceSen + height + tier', async () => {
    const { rows } = await catalog(2, '?id=x1');
    const shp = rows[0].seat_height_prices as Array<Record<string, unknown>>;
    expect(shp).toHaveLength(1);
    expect(shp[0]).not.toHaveProperty('priceSen');
    expect(shp[0]).toMatchObject({ height: 'S', sellingPriceSen: 70000, tier: 'PRICE_1' });
  });

  test('the product_models hero embed passes through intact', async () => {
    const { rows } = await catalog(2, '?id=x1');
    expect(rows[0].product_models).toMatchObject({ model_code: 'XM1', photo_url: '/product-models/xm1/photo/k.jpg' });
  });
});

describe('GET /pos-pools/product-size-variants — legacy pool: mapping + scope', () => {
  async function variants(companyId: number | null, query: string): Promise<{ rows: Array<Record<string, unknown>>; res: Response }> {
    const res = await appFor(companyId, productSizeVariantsHandler, '/product-size-variants').request('/product-size-variants' + query);
    const body = (await res.clone().json()) as { rows: Array<Record<string, unknown>> };
    return { rows: body.rows, res };
  }

  test('maps snake→camel, defaults pwpPrice null, and stays company-scoped', async () => {
    const { rows } = await variants(2, '?productId=p1');
    expect(rows).toEqual([
      { sizeId: 'queen', active: true, price: 1500, pwpPrice: null },
      { sizeId: 'king', active: false, price: 1800, pwpPrice: null },
    ]);
  });

  test('missing productId returns an empty list (no unscoped dump)', async () => {
    const { rows } = await variants(2, '');
    expect(rows).toEqual([]);
  });
});
