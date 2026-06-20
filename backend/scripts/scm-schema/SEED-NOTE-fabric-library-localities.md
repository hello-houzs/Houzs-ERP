# SEED FLAG — fabric_library + my_localities (2026-06-20)

Ported routes `/outstanding`, `/fabric-library` (GET list), `/localities` (GET
list) for the vendored Outstanding page, the sofa fabric-library picker, and the
SupplierDetail postcode cascade.

## Backing-table audit (READ-only introspection of the Houzs `scm` schema)

| Route                | Backing object(s)                | Exists? | Rows |
|----------------------|----------------------------------|---------|------|
| `/outstanding/*`     | `scm.v_*_outstanding` (7 views)  | YES     | live (driven by SO/PO/DO/etc. docs) |
| `/fabric-library` GET| `scm.fabric_library`             | YES     | **0 — EMPTY** |
| `/localities` GET    | `scm.my_localities`              | YES     | **0 — EMPTY** |

All three backing objects ALREADY EXIST in the `scm` schema (DDL lives in
`2990s-full-schema.sql`). **No CREATE TABLE migration is needed.** Columns match
the frontend shapes verbatim:

- `fabric_library`: `id, label, tier, default_surcharge, swatch_key, active, sort_order, sofa_tier, bedframe_tier, fabric_code`
- `my_localities`: `id, postcode, city, state, state_code, country, warehouse_id`

The routes DEGRADE GRACEFULLY — empty table → `{ fabrics: [] }` / `{ localities: [] }`
(and a missing relation is also caught → `[]`), so nothing 500s.

## What returns EMPTY until seeded

1. **`/fabric-library` GET** → `[]`. Effect: ProductModelDetail's sofa
   "fabrics offered" picker renders with no options. Seeds when the Fabric
   Converter (`POST /fabric-tracking`, which upserts `fabric_library`) is used,
   or via a direct seed.

2. **`/localities` GET** → `[]`. Effect: SupplierDetail's StateSelect falls
   back to a free-text State input (the source's verbatim no-data behaviour).

## SEPARATE TASK — MY postcode dataset seed (FLAGGED, not done)

The full Malaysia State→City→Postcode dataset is a large seed and is **out of
scope** for this route-porting wave. 2990's carries NO canonical INSERT seed for
`my_localities` in its migrations (rows are user-maintained / CSV-imported at
runtime), so there was nothing to port. To light up the postcode cascade:
load the MY locality dataset into `scm.my_localities` (state/state_code/city/
postcode/country='Malaysia') as a dedicated data-import task. Until then the
free-text fallback applies. NOT APPLIED here.
