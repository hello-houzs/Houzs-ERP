"""
Generate cloudflare-migrations/0007_seed_permissions.sql with sensible default
access levels for every (department, position, module) tuple.

Level conventions used below:
  FULL — CRUD including delete
  EDIT — create + update (no delete)
  VIEW — read-only
  NONE — hidden entirely

These are starting points — admin can override any cell in /admin/permissions.
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "cloudflare-migrations" / "0007_seed_permissions.sql"

MODULES = [
    # key                  group
    ("dashboard",          "PROJECT_MANAGEMENT"),
    ("calendar",           "PROJECT_MANAGEMENT"),
    ("finance",            "PROJECT_MANAGEMENT"),
    ("pms",                "PROJECT_MANAGEMENT"),
    ("settings",           "PROJECT_MANAGEMENT"),
    ("sales_team",         "SALES"),
    ("so_details",         "SALES"),
    ("so",                 "SALES"),
    ("sku_costing",        "SALES"),
    ("qms",                "QMS"),
    ("bd",                 "DEPARTMENTS"),
    ("operation",          "DEPARTMENTS"),
    ("driver",             "DEPARTMENTS"),
    ("admin_users",        "ADMIN"),
    ("admin_audit",        "ADMIN"),
    ("admin_permissions",  "ADMIN"),
]

ROLES = [
    ("HQ",        "Super Admin"),
    ("HQ",        "HR Manager"),
    ("HQ",        "Finance Manager"),
    ("HQ",        "Admin Assistant"),
    ("SALES",     "Sales Director"),
    ("SALES",     "Sales Manager"),
    ("SALES",     "Sales Executive"),
    ("SALES",     "Sales Trainee"),
    ("OPERATION", "Ops Director"),
    ("OPERATION", "Ops Manager"),
    ("OPERATION", "Ops Executive"),
    ("OPERATION", "Warehouse"),
    ("OPERATION", "Driver"),
]

# Default permission matrix — keyed by (dept, position) -> {module_key: level}
# Missing entries default to NONE.
DEFAULTS = {
    # ── HQ ──
    ("HQ", "Super Admin"): {m: "FULL" for m, _ in MODULES},
    ("HQ", "HR Manager"): {
        "dashboard": "VIEW", "calendar": "VIEW", "pms": "VIEW",
        "sales_team": "VIEW",
        "admin_users": "EDIT", "admin_audit": "VIEW",
    },
    ("HQ", "Finance Manager"): {
        "dashboard": "VIEW", "calendar": "VIEW", "finance": "FULL", "pms": "VIEW",
        "so_details": "VIEW", "so": "VIEW", "sku_costing": "VIEW",
        "admin_audit": "VIEW",
    },
    ("HQ", "Admin Assistant"): {
        "dashboard": "VIEW", "calendar": "EDIT", "pms": "VIEW",
        "admin_users": "VIEW",
    },

    # ── SALES ──
    ("SALES", "Sales Director"): {
        "dashboard": "FULL", "calendar": "FULL", "finance": "VIEW", "pms": "FULL",
        "settings": "VIEW", "sales_team": "FULL",
        "so_details": "FULL", "so": "FULL", "sku_costing": "FULL",
        "qms": "FULL",
        "admin_users": "VIEW", "admin_audit": "VIEW",
    },
    ("SALES", "Sales Manager"): {
        "dashboard": "VIEW", "calendar": "FULL", "pms": "FULL",
        "sales_team": "EDIT",
        "so_details": "EDIT", "so": "EDIT", "sku_costing": "VIEW",
        "qms": "EDIT",
    },
    ("SALES", "Sales Executive"): {
        "dashboard": "VIEW", "calendar": "EDIT", "pms": "VIEW",
        "sales_team": "VIEW",
        "so_details": "EDIT", "so": "EDIT", "sku_costing": "VIEW",
        "qms": "EDIT",
    },
    ("SALES", "Sales Trainee"): {
        "calendar": "VIEW", "pms": "VIEW",
        "so_details": "VIEW", "so": "VIEW", "sku_costing": "VIEW",
    },

    # ── OPERATION ──
    ("OPERATION", "Ops Director"): {
        "dashboard": "VIEW", "calendar": "FULL", "pms": "VIEW",
        "so_details": "VIEW", "so": "VIEW", "sku_costing": "VIEW",
        "qms": "FULL",
        "bd": "FULL", "operation": "FULL", "driver": "FULL",
    },
    ("OPERATION", "Ops Manager"): {
        "calendar": "EDIT", "pms": "VIEW",
        "so_details": "VIEW", "so": "VIEW",
        "qms": "EDIT",
        "bd": "EDIT", "operation": "FULL", "driver": "EDIT",
    },
    ("OPERATION", "Ops Executive"): {
        "calendar": "VIEW", "pms": "VIEW",
        "so_details": "VIEW", "so": "VIEW",
        "operation": "EDIT", "driver": "VIEW",
    },
    ("OPERATION", "Warehouse"): {
        "calendar": "VIEW",
        "so_details": "VIEW", "sku_costing": "VIEW",
        "operation": "EDIT",
    },
    ("OPERATION", "Driver"): {
        "calendar": "VIEW",
        "driver": "EDIT",
    },
}

def main():
    out = [
        "-- Default role_permissions matrix (admin can override any cell via UI).",
        "-- Uses INSERT OR IGNORE so re-running the migration is safe.",
        "",
    ]
    row_count = 0
    for role in ROLES:
        levels = DEFAULTS.get(role, {})
        for module_key, _ in MODULES:
            level = levels.get(module_key, "NONE")
            dept, pos = role
            out.append(
                f"INSERT OR IGNORE INTO role_permissions (department, position, module_key, level) "
                f"VALUES ('{dept}', '{pos.replace(chr(39), chr(39)+chr(39))}', '{module_key}', '{level}');"
            )
            row_count += 1
    print(f"Generated {row_count} permission rows ({len(ROLES)} roles × {len(MODULES)} modules)")
    OUT.write_text("\n".join(out), encoding="utf-8")
    print(f"Wrote {OUT}")

if __name__ == "__main__":
    main()
