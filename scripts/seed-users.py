"""
Parse the seedMembers array in src/lib/sales-store.ts and emit
cloudflare-migrations/0004_seed_users.sql with INSERT OR IGNORE rows.

All users start with:
  - password_hash = NULL  (they must use "Forgot password" to set one first time,
    OR admin triggers a password reset from Users page)
  - status from seed (ACTIVE for most)
  - must_change_password = 0 (will be flipped to 1 only via invite/reset flow)

Everyone in the seed is kept (including blank-email "OTHERS/SIANG/ALVIN" etc.)
so line-item filtering still works; blank-email rows just can't log in.
"""
from __future__ import annotations
import base64
import hashlib
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS_FILE = ROOT / "src" / "lib" / "sales-store.ts"
OUT_FILE = ROOT / "cloudflare-migrations" / "0004_seed_users.sql"

# Bootstrap admin — this is the first account that can actually log in.
# Password hash computed below with PBKDF2-SHA256 / 100k iters / 16-byte salt,
# matching the algo in functions/_auth.ts so the server can verify it.
BOOTSTRAP_ADMIN = {
    "id":       "dir-hello",
    "name":     "HOUZS ADMIN",
    "code":     "ADMIN",
    "email":    "hello@houzscentury.com",
    "phone":    "",
    "position": "Sales Director",
    "password": "Houzs@815518",
}

PBKDF2_ITERS = 100_000

def hash_password(password: str) -> tuple[str, str]:
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERS, 32)
    return base64.b64encode(key).decode(), base64.b64encode(salt).decode()

def sqlstr(v) -> str:
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"

def parse_members() -> list[dict]:
    text = TS_FILE.read_text(encoding="utf-8")
    # Find the seedMembers array block
    m = re.search(r"const seedMembers:\s*SalesMember\[\]\s*=\s*\[(.*?)\n\];", text, re.S)
    if not m:
        raise SystemExit("Could not locate seedMembers array in sales-store.ts")
    block = m.group(1)

    members = []
    # Each row is `{ ... },` possibly with inline commission tier arrays
    # Strategy: greedily match balanced { ... } blocks
    depth = 0
    start = None
    for i, ch in enumerate(block):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                row = block[start:i+1]
                members.append(parse_row(row))
                start = None
    return members

FIELD_RE = re.compile(r'(\w+)\s*:\s*', re.S)

def parse_row(src: str) -> dict:
    """Parse a single { id: "x", ... } TS object literal into a dict.
       Good enough for our tightly-controlled seed shape."""
    out = {}
    # Strip braces
    body = src.strip()
    assert body.startswith("{") and body.endswith("}"), body
    body = body[1:-1]

    # Walk top-level field : value pairs
    i = 0
    n = len(body)
    while i < n:
        # skip whitespace + commas
        while i < n and body[i] in " \t\r\n,":
            i += 1
        if i >= n:
            break
        # match field name
        m = re.match(r'(\w+)\s*:\s*', body[i:])
        if not m:
            break
        key = m.group(1)
        i += m.end()
        # now read a value: string, number, bool, array, or object
        value, consumed = read_value(body, i)
        out[key] = value
        i += consumed
    return out

def read_value(s: str, start: int):
    """Return (value, chars_consumed) beginning at index `start`."""
    i = start
    n = len(s)
    # skip ws
    while i < n and s[i] in " \t\r\n":
        i += 1
    ch = s[i]
    # String literal
    if ch in ('"', "'"):
        quote = ch
        j = i + 1
        while j < n and s[j] != quote:
            if s[j] == "\\":
                j += 2
            else:
                j += 1
        val = s[i+1:j]
        return val, (j + 1) - start
    # Array
    if ch == "[":
        depth = 0
        j = i
        while j < n:
            if s[j] == "[":
                depth += 1
            elif s[j] == "]":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        # Parse naive array; for our seed it's list of strings or list of objects
        raw = s[i:j+1]
        return parse_ts_array(raw), (j + 1) - start
    # Object (shouldn't happen at top level of our seed rows)
    if ch == "{":
        depth = 0
        j = i
        while j < n:
            if s[j] == "{": depth += 1
            elif s[j] == "}":
                depth -= 1
                if depth == 0: break
            j += 1
        raw = s[i:j+1]
        return parse_row(raw), (j + 1) - start
    # Number / bool / bareword
    j = i
    while j < n and s[j] not in ",}\n":
        j += 1
    token = s[i:j].strip()
    if token == "true": return True, j - start
    if token == "false": return False, j - start
    if token == "null" or token == "": return None, j - start
    # try number
    try:
        if "." in token: return float(token), j - start
        return int(token), j - start
    except ValueError:
        return token, j - start

def parse_ts_array(raw: str):
    """Parse a TS array literal like ["AKEMI","ZANOTTI"] or [{threshold:0,pct:5}]."""
    # Remove outer brackets
    body = raw.strip()[1:-1].strip()
    if not body:
        return []
    items = []
    i, n = 0, len(body)
    while i < n:
        while i < n and body[i] in " \t\r\n,":
            i += 1
        if i >= n: break
        val, consumed = read_value(body, i)
        items.append(val)
        i += consumed
    return items

def build_sql() -> str:
    members = parse_members()
    print(f"Parsed {len(members)} members from sales-store.ts")

    # Pre-hash the bootstrap admin password once, at seed-build time
    boot_hash, boot_salt = hash_password(BOOTSTRAP_ADMIN["password"])
    print(f"Bootstrap admin: {BOOTSTRAP_ADMIN['email']}  hash={boot_hash[:16]}...")

    out = [
        "-- Seed users table from src/lib/sales-store.ts seedMembers.",
        "-- INSERT OR IGNORE so re-running the migration is safe.",
        "-- No BEGIN/COMMIT — D1 wraps the whole file in a single transaction.",
        "",
        "-- ── Bootstrap admin (logs in out-of-the-box) ────────────────────────",
        "INSERT OR IGNORE INTO users (id, name, code, email, phone, position, "
        "join_date, status, assigned_brands, commission_tiers, min_rate, "
        "password_hash, password_salt, must_change_password) VALUES (",
        f"  {sqlstr(BOOTSTRAP_ADMIN['id'])}, "
        f"{sqlstr(BOOTSTRAP_ADMIN['name'])}, "
        f"{sqlstr(BOOTSTRAP_ADMIN['code'])}, "
        f"{sqlstr(BOOTSTRAP_ADMIN['email'])}, "
        f"{sqlstr(BOOTSTRAP_ADMIN['phone'])}, "
        f"{sqlstr(BOOTSTRAP_ADMIN['position'])}, "
        "'2024-01-01', 'ACTIVE', '[\"AKEMI\",\"ZANOTTI\",\"ERGOTEX\",\"DUNLOPILLO\",\"HOUZS\"]', "
        "'[]', 0, "
        f"{sqlstr(boot_hash)}, {sqlstr(boot_salt)}, 0",
        ");",
        "",
    ]
    for m in members:
        id_      = m["id"]
        name     = m["name"]
        code     = m.get("code") or ""
        email    = m.get("email") or ""
        phone    = m.get("phone") or ""
        ic       = m.get("ic") or ""
        pos      = m["position"]
        parent   = m.get("parentId") or None
        addl     = m.get("additionalParentIds") or []
        join_d   = m.get("joinDate") or "2024-01-01"
        status   = m.get("status") or "ACTIVE"
        brands   = m.get("assignedBrands") or []
        tiers    = m.get("commissionTiers") or []
        min_rate = m.get("minRate") or 0

        out.append(
            "INSERT OR IGNORE INTO users (id, name, code, email, phone, ic, position, "
            "parent_id, additional_parent_ids, join_date, status, assigned_brands, "
            "commission_tiers, min_rate) VALUES ("
            f"{sqlstr(id_)}, {sqlstr(name)}, {sqlstr(code)}, {sqlstr(email) if email else 'NULL'}, "
            f"{sqlstr(phone)}, {sqlstr(ic)}, {sqlstr(pos)}, "
            f"{sqlstr(parent) if parent else 'NULL'}, "
            f"{sqlstr(json.dumps(addl))}, "
            f"{sqlstr(join_d)}, {sqlstr(status)}, "
            f"{sqlstr(json.dumps(brands))}, "
            f"{sqlstr(json.dumps(tiers))}, "
            f"{min_rate}"
            ");"
        )
    return "\n".join(out)

def main():
    sql = build_sql()
    OUT_FILE.write_text(sql, encoding="utf-8")
    print(f"Wrote {OUT_FILE}  ({len(sql)} chars)")

if __name__ == "__main__":
    main()
