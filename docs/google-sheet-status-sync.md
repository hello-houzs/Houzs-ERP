# HC Delivery sheet — ASSR status sync (ERP → Google Sheet)

Nick 2026-07-14: the ERP is the source of truth for service cases; the
`ASSR Case (Farra)` tab of the **HC Delivery Updated** spreadsheet keeps a
hand-maintained `ASSR STATUS` column (A) that had drifted (it still showed
retired stages like *Pending Inspection* / *Pending Item Pickup*). Every
**10 minutes** a sheet-bound Apps Script pulls the ERP's live stages and
rewrites column A, so the sheet's own stats block (rows 1–13) stays honest
without anyone re-keying.

**Status: INSTALLED AND LIVE since 2026-07-14.** The script lives in the
sheet-bound Apps Script project **“Delivery & Amend Updated”** as
`ASSRStatusSync.gs`, with a 10-minute time trigger on `syncAssrStatus`.
The first full sync rewrote 73 rows. This doc is the source-controlled
record of that script (the project itself is not in git).

## Pieces

| Side | What | Where |
|---|---|---|
| ERP | `GET /api/assr-form-intake/status-export` — all non-archived cases as `{assr_no, so_no, ref_no, status, completed_date}`; guarded by `X-Intake-Key` accepting either `FORM_INTAKE_KEY` or the dedicated `SHEET_SYNC_KEY` | `backend/src/routes/assrFormIntake.ts` |
| Google | `ASSRStatusSync.gs` (`syncAssrStatus()` + 10-minute trigger) in the sheet-bound Apps Script project “Delivery & Amend Updated” | script below |
| Google | `ASSRDeliverySync.gs` (pre-existing) — its `ASSR_DELIVERY_TRIGGERS` map gained the new 7-stage vocabulary so the ASSR → Delivery Details linkage keeps working | snippet below |

## Matching (sheet row → ERP case)

Data rows start at **row 16**. For each row:

1. **`ASSR NO` (col C)** exact match — covers the ~337 rows already carrying
   `ASSR/…` numbers.
2. Else **`SO NO` (col B)**: if exactly one ERP case has that SO, use it;
   if several, disambiguate by **`Ref No` (col E)**; still ambiguous → the
   row is left untouched (never guess).
3. No match → row untouched (old rows that never entered the ERP keep
   whatever status they have).

Only column A is written, and only when the value actually changed. The
ERP sends the sheet's exact vocabulary (`Completed`, `Under Verification`,
`Pending Solution`, `Pending Supplier Pickup`, `Pending Item Ready`,
`Pending Delivery/Service`, `Pending Review`). The column-A data-validation
dropdown was extended to accept `Pending Review` (it rejected the first
sync until then).

## ASSR → Delivery Details linkage

The project’s pre-existing `ASSRDeliverySync.gs` watches manual edits to
column A (installable onEdit) and, on certain statuses, adds/updates a row
in the regional delivery sheet (`Delivery Details` / `EM Order` /
`SG Order`) tagged `{DocNo}-{PICKUP|SERVICE|INSPECTION}` in col B.

Programmatic writes **never fire onEdit**, so `syncAssrStatus()` calls
`syncASSRToDelivery()` directly — with a synthetic `{range}` event — for
every row that just **entered** a trigger status. Its trigger map now
covers both vocabularies (added 2026-07-14):

```javascript
const ASSR_DELIVERY_TRIGGERS = {
  "Pending Item Pickup":      "PICKUP",      // legacy manual vocabulary
  "Pending Delivery/Service": "SERVICE",
  "Pending Inspection":       "INSPECTION",  // legacy manual vocabulary
  // 2026-07 ERP 7-stage vocabulary — same delivery actions:
  "Pending Supplier Pickup":  "PICKUP",
  "Under Verification":       "INSPECTION"
};
```

The linkage fires only on a **transition into** a trigger status. Cases
that were already sitting in a trigger status when this went live did NOT
get rows backfilled (as of install: 45 such rows already had delivery rows
from the manual era, 19 did not — 5 Pending Supplier Pickup,
11 Under Verification, 3 Pending Delivery/Service).

## Apps Script (as installed — `ASSRStatusSync.gs`)

`<SHEET_SYNC_KEY>` below is the real key in the installed copy — value in
the GitHub Actions secret `SHEET_SYNC_KEY`. Never commit it here.

```javascript
// ============================================================
// ASSRStatusSync.gs - ERP -> sheet ASSR STATUS sync (10-minute)
// The ERP is the source of truth for service-case stages; this
// rewrites column A of "ASSR Case (Farra)" from the ERP every 10
// minutes. Matching: ASSR NO (col C) exact, else SO NO (col B),
// disambiguated by Ref No (col E). Unmatched rows are never touched.
//
// Rows that ENTER a delivery-trigger status (ASSR_DELIVERY_TRIGGERS
// in ASSRDeliverySync.gs) are handed to syncASSRToDelivery() with a
// synthetic event: programmatic writes never fire onEdit, so the
// ASSR -> Delivery linkage must be called from here.
// Docs: Houzs-ERP repo, docs/google-sheet-status-sync.md
// ============================================================

var ASSR_SYNC_URL = "https://erp.houzscentury.com/api/assr-form-intake/status-export";
var ASSR_SYNC_KEY = "<SHEET_SYNC_KEY>";
var ASSR_SYNC_TAB = "ASSR Case (Farra)";
var ASSR_SYNC_DATA_START_ROW = 16;

function syncAssrStatus() {
  var res = UrlFetchApp.fetch(ASSR_SYNC_URL, {
    headers: { "X-Intake-Key": ASSR_SYNC_KEY },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error("[syncAssrStatus] HTTP " + res.getResponseCode());
    return;
  }
  var cases = (JSON.parse(res.getContentText()).cases) || [];
  if (!cases.length) {
    console.warn("[syncAssrStatus] 0 cases returned - aborting, sheet untouched");
    return;
  }

  var byAssr = {};
  var bySo = {};
  cases.forEach(function (c) {
    if (c.assr_no) byAssr[String(c.assr_no).trim()] = c;
    if (c.so_no) {
      var k = String(c.so_no).trim();
      (bySo[k] = bySo[k] || []).push(c);
    }
  });

  var sh = SpreadsheetApp.getActive().getSheetByName(ASSR_SYNC_TAB);
  var lastRow = sh.getLastRow();
  if (lastRow < ASSR_SYNC_DATA_START_ROW) return;
  var n = lastRow - ASSR_SYNC_DATA_START_ROW + 1;
  var rows = sh.getRange(ASSR_SYNC_DATA_START_ROW, 1, n, 5).getValues();

  var updated = 0;
  var deliveryRows = []; // sheet rows that just ENTERED a delivery-trigger status
  var statusCol = rows.map(function (r) { return [r[0]]; });
  rows.forEach(function (r, i) {
    var so = String(r[1] || "").trim();
    var assr = String(r[2] || "").trim();
    var ref = String(r[4] || "").trim();
    var hit = (assr && byAssr[assr]) || null;
    if (!hit && so && bySo[so]) {
      var list = bySo[so];
      if (list.length === 1) {
        hit = list[0];
      } else if (ref) {
        hit = list.filter(function (c) {
          return c.ref_no && String(c.ref_no).trim() === ref;
        })[0] || null;
      }
      // several ERP cases on the SO and no Ref match -> leave the row alone
    }
    if (hit && hit.status && String(r[0] || "").trim() !== hit.status) {
      statusCol[i][0] = hit.status;
      updated++;
      if (typeof ASSR_DELIVERY_TRIGGERS !== "undefined" && ASSR_DELIVERY_TRIGGERS[hit.status]) {
        deliveryRows.push(ASSR_SYNC_DATA_START_ROW + i);
      }
    }
  });

  if (updated) {
    sh.getRange(ASSR_SYNC_DATA_START_ROW, 1, n, 1).setValues(statusCol);
    // ASSR -> Delivery linkage for rows that just entered a trigger status.
    deliveryRows.forEach(function (rowIdx) {
      try {
        syncASSRToDelivery({ range: sh.getRange(rowIdx, 1) });
      } catch (err) {
        console.error("[syncAssrStatus] delivery link R" + rowIdx + ": " + err);
      }
    });
  }
  console.log("[syncAssrStatus] " + updated + " of " + n + " rows updated, " +
    deliveryRows.length + " delivery-linked (ERP cases: " + cases.length + ")");
}

// Run ONCE to (re)install the every-10-minutes trigger.
function setupAssrStatusTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "syncAssrStatus") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncAssrStatus").timeBased().everyMinutes(10).create();
  console.log("[setupAssrStatusTrigger] 10-minute trigger installed");
}
```

## Notes

- Read-only on the ERP side; the endpoint returns no customer PII (the
  sheet already holds the customer columns — the sync never touches them).
- The sync only ever writes column A (plus whatever `syncASSRToDelivery`
  writes to the delivery sheets on a trigger transition). Manual edits to
  column A on a **matched** row are overwritten within 10 minutes — the
  ERP is the source of truth; change the stage in the ERP instead.
- Rows that never became ERP cases keep their hand-keyed status forever.
- To reinstall or change the cadence, edit and run
  `setupAssrStatusTrigger` in the Apps Script editor (it replaces any
  existing `syncAssrStatus` triggers).
