"""Generate D1 seed SQL from the existing JSON seeds.

Reads:
  - src/data/sku-master.json
  - src/data/so-headers.json
  - src/data/so-lines.json

Writes:
  - cloudflare-migrations/0002_seed.sql

After this, apply with:
  npx wrangler d1 execute houzs-erp --file=cloudflare-migrations/0002_seed.sql --remote
"""
from __future__ import annotations
import json, pathlib

ROOT = pathlib.Path('C:/Users/User/Desktop/houzs-erp')
DATA = ROOT / 'src' / 'data'
OUT = ROOT / 'cloudflare-migrations' / '0002_seed.sql'

def q(v):
    """Escape a value for SQL insertion. Returns 'NULL' or '...'."""
    if v is None or v == "":
        return 'NULL'
    if isinstance(v, bool):
        return '1' if v else '0'
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"

lines_out = []
lines_out.append("-- Auto-generated seed. Do NOT edit. Regenerate via scripts/seed-d1.py")
lines_out.append("")
lines_out.append("-- 1. SKUs")
skus = json.loads((DATA / 'sku-master.json').read_text(encoding='utf-8'))
lines_out.append(f"-- {len(skus)} SKUs")
# Wrapper in transaction-friendly batches of 200
BATCH = 200
for i in range(0, len(skus), BATCH):
    chunk = skus[i:i+BATCH]
    values = []
    for s in chunk:
        values.append(
            f"({q(s['id'])}, {q(s['itemCode'])}, {q(s['description'])}, {q(s['itemGroup'] or 'OTHER')}, "
            f"{q(s.get('uom') or 'UNIT')}, {q(s.get('supplier'))}, {q(s.get('barCode'))}, "
            f"{q(s.get('costPrice') or 0)}, 0, {q(s.get('brand') or 'OTHER')}, {q('2026-04-22T00:00:00')}, NULL)"
        )
    lines_out.append(
        "INSERT OR REPLACE INTO skus "
        "(id, item_code, description, item_group, uom, supplier, bar_code, cost_price, selling_price, brand, last_updated, notes) "
        f"VALUES\n{','.join(values)};"
    )

lines_out.append("")
lines_out.append("-- 2. SO Headers")
headers = json.loads((DATA / 'so-headers.json').read_text(encoding='utf-8'))
lines_out.append(f"-- {len(headers)} SO headers")
for i in range(0, len(headers), BATCH):
    chunk = headers[i:i+BATCH]
    values = []
    for h in chunk:
        values.append(
            f"({q(h['docNo'])}, {q(h.get('transferTo'))}, {q(h['date'])}, {q(h.get('branding'))}, "
            f"{q(h['debtorName'])}, {q(h.get('agent'))}, {q(h.get('salesLocation'))}, {q(h.get('ref'))}, "
            f"{h.get('localTotal') or 0}, {h.get('mattressSofa') or 0}, {h.get('bedframe') or 0}, "
            f"{h.get('accessories') or 0}, {h.get('others') or 0}, {h.get('balance') or 0}, "
            f"{q(h.get('remark2'))}, {q(h.get('remark4'))}, {q(h.get('remark3'))}, "
            f"{q(h.get('processingDate'))}, {q(h.get('salesExemptionExpiry'))}, {q(h.get('note'))}, "
            f"{q(h.get('poDocNo'))}, {q(h.get('address1'))}, {q(h.get('address2'))}, "
            f"{q(h.get('address3'))}, {q(h.get('address4'))}, {q(h.get('phone'))}, {q(h.get('venue'))}, "
            f"{h.get('totalCost') or 0}, {h.get('totalRevenue') or 0}, {h.get('totalMargin') or 0}, "
            f"{h.get('marginPct') or 0}, {h.get('lineCount') or 0})"
        )
    lines_out.append(
        "INSERT OR REPLACE INTO so_headers "
        "(doc_no, transfer_to, date, branding, debtor_name, agent, sales_location, ref, "
        "local_total, mattress_sofa, bedframe, accessories, others, balance, "
        "remark2, remark4, remark3, processing_date, sales_exemption_expiry, note, "
        "po_doc_no, address1, address2, address3, address4, phone, venue, "
        "total_cost, total_revenue, total_margin, margin_pct, line_count) "
        f"VALUES\n{','.join(values)};"
    )

lines_out.append("")
lines_out.append("-- 3. SO Lines")
so_lines = json.loads((DATA / 'so-lines.json').read_text(encoding='utf-8'))
lines_out.append(f"-- {len(so_lines)} SO lines")

# Filter out lines whose item_code doesn't exist in SKUs (FK violation otherwise)
sku_codes = {s['itemCode'] for s in skus}
valid_lines = [l for l in so_lines if l['itemCode'] in sku_codes]
skipped = len(so_lines) - len(valid_lines)
if skipped:
    lines_out.append(f"-- Skipped {skipped} lines missing from SKU master (FK violation)")

# Also need to filter out lines whose docNo doesn't exist in headers
header_docs = {h['docNo'] for h in headers}
valid_lines = [l for l in valid_lines if l['docNo'] in header_docs]

for i in range(0, len(valid_lines), BATCH):
    chunk = valid_lines[i:i+BATCH]
    values = []
    for l in chunk:
        values.append(
            f"({q(l['id'])}, {q(l['docNo'])}, {q(l['date'])}, {q(l.get('debtorCode'))}, "
            f"{q(l.get('debtorName'))}, {q(l.get('agent'))}, {q(l['itemGroup'])}, {q(l['itemCode'])}, "
            f"{q(l.get('description'))}, {q(l.get('description2'))}, {q(l.get('uom') or 'UNIT')}, "
            f"{q(l.get('location'))}, {l.get('qty') or 1}, {l.get('unitPrice') or 0}, "
            f"{l.get('discount') or 0}, {l.get('total') or 0}, {l.get('tax') or 0}, "
            f"{l.get('totalInc') or 0}, {l.get('balance') or 0}, "
            f"{q(l.get('payment') or 'Unchecked')}, {q(l.get('venue'))}, {q(l.get('branding'))}, "
            f"{q(l.get('remark'))}, {1 if l.get('cancelled') else 0}, NULL, "
            f"{l.get('unitCost') or 0}, {l.get('lineCost') or 0}, {l.get('lineMargin') or 0})"
        )
    lines_out.append(
        "INSERT OR REPLACE INTO so_lines "
        "(id, doc_no, date, debtor_code, debtor_name, agent, item_group, item_code, description, description2, "
        "uom, location, qty, unit_price, discount, total, tax, total_inc, balance, payment_status, venue, branding, "
        "remark, cancelled, variants, unit_cost, line_cost, line_margin) "
        f"VALUES\n{','.join(values)};"
    )

lines_out.append("")
lines_out.append("-- 4. Default variants config")
default_variants = {
  "divanHeights": [{"value":'4"',"priceSen":0},{"value":'5"',"priceSen":0},{"value":'6"',"priceSen":0},{"value":'8"',"priceSen":0},{"value":'10"',"priceSen":5000},{"value":'11"',"priceSen":12000},{"value":'12"',"priceSen":12000},{"value":'13"',"priceSen":14000},{"value":'14"',"priceSen":14000},{"value":'16"',"priceSen":15000}],
  "legHeights": [{"value":"No Leg","priceSen":0},{"value":'1"',"priceSen":0},{"value":'2"',"priceSen":0},{"value":'4"',"priceSen":0},{"value":'6"',"priceSen":0},{"value":'7"',"priceSen":16000}],
  "totalHeights": [{"value":'10"',"priceSen":0},{"value":'12"',"priceSen":0},{"value":'14"',"priceSen":0},{"value":'16"',"priceSen":5000},{"value":'18"',"priceSen":5000},{"value":'20"',"priceSen":10000},{"value":'22"',"priceSen":12000},{"value":'24"',"priceSen":14000},{"value":'26"',"priceSen":15000},{"value":'28"',"priceSen":16000}],
  "gaps": ['4"','5"','6"','7"','8"','9"','10"'],
  "specials": [{"value":"HB Fully Cover","priceSen":5000},{"value":"Divan Top Fully Cover","priceSen":5000},{"value":"Divan Full Cover","priceSen":8000},{"value":"Left Drawer","priceSen":15000},{"value":"Right Drawer","priceSen":15000},{"value":"Front Drawer","priceSen":12000},{"value":"HB Straight","priceSen":0},{"value":"Divan Top(W)","priceSen":0},{"value":"1 Piece Divan","priceSen":25000},{"value":"Divan Curve","priceSen":5000},{"value":"No Side Panel","priceSen":4000},{"value":"Headboard Only","priceSen":0},{"value":"Nylon Fabric","priceSen":0},{"value":"5537 Backrest","priceSen":0},{"value":'Add 1" Infront L',"priceSen":0},{"value":"Separate Backrest Packing","priceSen":0},{"value":"Divan A11","priceSen":0},{"value":'Seat Add On 4"',"priceSen":0}],
  "sofaLegHeights": [{"value":"No Leg","priceSen":0},{"value":'4"',"priceSen":0},{"value":'6"',"priceSen":0}],
  "sofaSpecials": [{"value":"Nylon Fabric","priceSen":0},{"value":"5537 Backrest","priceSen":0},{"value":"Separate Backrest Packing","priceSen":0}],
  "sofaSizes": ["24","26","28","30","32","35"]
}
dv_json = json.dumps(default_variants, ensure_ascii=False)
lines_out.append(f"INSERT OR REPLACE INTO variants_config (id, config) VALUES (1, {q(dv_json)});")

OUT.write_text("\n".join(lines_out), encoding='utf-8')
print(f"Wrote {OUT}")
print(f"  SKUs: {len(skus)}")
print(f"  Headers: {len(headers)}")
print(f"  Lines: {len(valid_lines)} (skipped {skipped})")
print(f"  Size: {OUT.stat().st_size / 1024:.1f} KB")
