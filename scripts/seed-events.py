"""
Convert src/data/events-imported.json → 0012_seed_events.sql.
Uses INSERT OR IGNORE so re-applying is safe.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "data" / "events-imported.json"
OUT = ROOT / "cloudflare-migrations" / "0012_seed_events.sql"

def esc(v) -> str:
    if v is None: return "NULL"
    if isinstance(v, bool): return "1" if v else "0"
    if isinstance(v, (int, float)): return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"

def main():
    events = json.loads(SRC.read_text(encoding="utf-8"))
    lines = [
        "-- Seed events from src/data/events-imported.json.",
        "-- Idempotent (INSERT OR IGNORE).",
        "",
    ]
    for e in events:
        # Shield JSON arrays
        assigned = json.dumps(e.get("assignedSales") or [])
        drivers = json.dumps(e.get("setupDrivers") or [])
        loris = json.dumps(e.get("setupLoris") or [])
        cols = [
            "a42", "status", "progress", "year", "month",
            "start_date", "end_date", "duration_days",
            "organizer", "state", "venue", "brand", "event_type", "contractor",
            "agreement_approval", "floorplan", "booth_no", "size_sqm",
            "send_floorplan_to_designer", "three_d_checked_by_mgt",
            "three_d_approved_by_peter", "three_d_uploaded_in_notion",
            "weekend_activity_theme", "license_majlis", "work_loading_bay_permit",
            "deco_coffee_table", "sec_depo_refund",
            "total_sales_rm", "rental_rm",
            "link_notion", "gcal_id", "pic", "bd_pic", "sales_pic",
            "preparation_condition", "setup_driver", "setup_lori",
            "setup_datetime", "dismantle_datetime", "setup_dismantle_status",
            "assigned_sales", "setup_drivers", "setup_loris",
        ]
        vals = [
            esc(e["a42"]), esc(e.get("status") or "CONFIRMED"),
            esc(e.get("progress") or "NOT STARTED"),
            esc(e.get("year") or 0), esc(e.get("month") or ""),
            esc(e.get("startDate") or ""), esc(e.get("endDate") or ""),
            esc(e.get("durationDays") or 1),
            esc(e.get("organizer") or ""), esc(e.get("state") or ""),
            esc(e.get("venue") or ""), esc(e.get("brand") or "OTHER"),
            esc(e.get("eventType") or "EXHIBITION"), esc(e.get("contractor") or ""),
            esc(e.get("agreementApproval") or ""),
            esc(e.get("floorplan") or ""),
            esc(e.get("boothNo") or ""),
            esc(e.get("sizeSqm") or 0),
            esc(e.get("sendFloorplanToDesigner") or ""),
            esc(e.get("threeDCheckedByMgt") or ""),
            esc(e.get("threeDApprovedByPeter") or ""),
            esc(e.get("threeDUploadedInNotion") or ""),
            esc(e.get("weekendActivityTheme") or ""),
            esc(e.get("licenseMajlis") or ""),
            esc(e.get("workLoadingBayPermit") or ""),
            esc(e.get("decoCoffeeTable") or ""),
            esc(e.get("secDepoRefund") or ""),
            esc(e.get("totalSalesRm") or 0),
            esc(e.get("rentalRm") or 0),
            esc(e.get("linkNotion")), esc(e.get("gcalId")),
            esc(e.get("pic")), esc(e.get("bdPic")), esc(e.get("salesPic")),
            esc(e.get("preparationCondition")),
            esc(e.get("setupDriver")), esc(e.get("setupLori")),
            esc(e.get("setupDatetime")), esc(e.get("dismantleDatetime")),
            esc(e.get("setupDismantleStatus")),
            esc(assigned), esc(drivers), esc(loris),
        ]
        lines.append(
            f"INSERT OR IGNORE INTO events ({', '.join(cols)}) VALUES ({', '.join(vals)});"
        )
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {OUT}  ({len(events)} events, {OUT.stat().st_size:,} bytes)")

if __name__ == "__main__":
    main()
