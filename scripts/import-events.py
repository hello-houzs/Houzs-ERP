"""
Read the EVENT SCHEDULE sheet from Exhibition & Solo Analysis.xlsx, filter to
events starting 2026-01-01 or later, map to HouzsEvent shape, and write
src/data/events-imported.json.

Usage: python scripts/import-events.py <excel_path>
       python scripts/import-events.py  (defaults to latest in Downloads)
"""
from __future__ import annotations
import json, re, sys
from datetime import datetime, date
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("pip install openpyxl required")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "events-imported.json"

DEFAULT_XLSX = Path("C:/Users/User/Downloads/Exhibition & Solo Analysis (4).xlsx")

# Column index (0-based) → HouzsEvent field name
COL_MAP = {
    0:  "a42",
    1:  "status",
    2:  "progress",
    3:  "year",
    4:  "month",
    5:  "startDate",
    6:  "endDate",
    7:  "durationDays",
    8:  "organizer",
    9:  "state",
    10: "venue",
    11: "brand",
    12: "eventType",
    13: "contractor",
    14: "agreementApproval",
    15: "floorplan",
    16: "boothNo",
    17: "sizeSqm",
    18: "sendFloorplanToDesigner",
    19: "threeDCheckedByMgt",
    20: "threeDApprovedByPeter",
    21: "threeDUploadedInNotion",
    22: "weekendActivityTheme",
    23: "licenseMajlis",
    24: "workLoadingBayPermit",
    25: "decoCoffeeTable",
    26: "secDepoRefund",
    27: "totalSalesRm",
    28: "rentalRm",
    29: "linkNotion",
    30: "gcalId",
}

# Fields that are WorkflowFlag strings (normalise to TRUE/FALSE/DONE/"NO NEED"/"")
WORKFLOW_FIELDS = {
    "agreementApproval", "floorplan", "sendFloorplanToDesigner",
    "threeDCheckedByMgt", "threeDApprovedByPeter", "threeDUploadedInNotion",
    "weekendActivityTheme", "licenseMajlis", "workLoadingBayPermit",
    "decoCoffeeTable", "secDepoRefund",
}

VALID_BRANDS = {"AKEMI","ZANOTTI","ERGOTEX","DUNLOPILLO","HOUZS","MYLATEX",
                "GETHA","AERO","THL3","JM","TNS","NAKI","CARRESS","NICOLLO",
                "ARMANI","DORSETTLOFT","ANNEX","MAJESTIC","TODERN","LAVEO",
                "BEST","RED_SOFA","C_AND_C","OTHER"}

VALID_STATES = {"KL","SELANGOR","PENANG","JOHOR","KEDAH","PERAK",
                "NEGERI SEMBILAN","PAHANG","TERENGGANU","KELANTAN","MELAKA",
                "PUTRAJAYA","PERLIS","SABAH","SARAWAK","LABUAN","SEREMBAN",
                "IPOH","KUANTAN"}
STATE_ALIASES = {"SEREMBAN": "NEGERI SEMBILAN", "IPOH": "PERAK", "KUANTAN": "PAHANG"}

def norm_flag(v) -> str:
    if v is True: return "TRUE"
    if v is False: return "FALSE"
    if v is None: return ""
    s = str(v).strip().upper()
    if s in ("TRUE","DONE","NO NEED","FALSE"): return s
    if s == "": return ""
    return s  # pass through anything custom

def to_iso_date(v) -> str:
    if isinstance(v, datetime): return v.strftime("%Y-%m-%d")
    if isinstance(v, date):     return v.strftime("%Y-%m-%d")
    return ""

def to_num(v, default=0):
    if v is None: return default
    if isinstance(v,(int,float)): return float(v)
    try: return float(str(v).replace(",",""))
    except Exception: return default

def clean_row(row):
    d = {}
    for idx, field in COL_MAP.items():
        val = row[idx] if idx < len(row) else None
        if field in WORKFLOW_FIELDS:
            d[field] = norm_flag(val)
        elif field in ("year","durationDays"):
            d[field] = int(to_num(val))
        elif field in ("sizeSqm","totalSalesRm","rentalRm"):
            d[field] = round(to_num(val), 2)
        elif field in ("startDate","endDate"):
            d[field] = to_iso_date(val)
        else:
            d[field] = str(val).strip() if val is not None else ""
    return d

def main():
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        print(f"File not found: {xlsx}"); sys.exit(1)

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    ws = wb["EVENT SCHEDULE"]
    all_rows = list(ws.iter_rows(values_only=True))
    print(f"Loaded {len(all_rows)-1} rows from EVENT SCHEDULE")

    cutoff = date(2026, 1, 1)
    cleaned = []
    skipped = 0
    dup = set()
    for row in all_rows[1:]:
        if not row or not row[0]:  # no A42 → skip
            skipped += 1
            continue
        start = row[5]
        if isinstance(start, datetime): start = start.date()
        if not isinstance(start, date) or start < cutoff:
            skipped += 1
            continue
        clean = clean_row(row)
        # Validate brand — downstream TS type is strict. Unknown brands go to OTHER.
        brand = clean["brand"].upper()
        if brand not in VALID_BRANDS: brand = "OTHER"
        clean["brand"] = brand
        # State normalisation — map cities to states where needed
        st = clean["state"].upper()
        clean["state"] = STATE_ALIASES.get(st, st)
        # Dedup by a42
        if clean["a42"] in dup:
            skipped += 1
            continue
        dup.add(clean["a42"])
        cleaned.append(clean)

    # Sort chronological
    cleaned.sort(key=lambda e: (e["startDate"], e["a42"]))

    print(f"Kept {len(cleaned)} events (skipped {skipped})")
    print(f"Date range: {cleaned[0]['startDate']} - {cleaned[-1]['startDate']}")
    brands = {}
    for e in cleaned: brands[e["brand"]] = brands.get(e["brand"], 0) + 1
    print(f"Brand breakdown: {brands}")

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(cleaned, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}  ({OUT.stat().st_size:,} bytes)")

if __name__ == "__main__":
    main()
