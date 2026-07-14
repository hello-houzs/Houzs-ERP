# HC Delivery sheet — ASSR status sync (ERP → Google Sheet)

Nick 2026-07-14: the ERP is the source of truth for service cases; the
`ASSR Case (Farra)` tab of the **HC Delivery Updated** spreadsheet keeps a
hand-maintained `ASSR STATUS` column (A) that had drifted (it still showed
retired stages like *Pending Inspection* / *Pending Item Pickup*). Every
**10 minutes** a sheet-bound Apps Script pulls the ERP's live stages and
rewrites column A, so the sheet's own stats block (rows 1–13) stays honest
without anyone re-keying.

## Pieces

| Side | What | Where |
|---|---|---|
| ERP | `GET /api/assr-form-intake/status-export` — all non-archived cases as `{assr_no, so_no, ref_no, status, completed_date}`; guarded by the same `X-Intake-Key` shared secret as the form-intake webhook | `backend/src/routes/assrFormIntake.ts` |
| Google | `syncAssrStatus()` + a 10-minute time trigger, added to the **same sheet-bound Apps Script project** that already POSTs form submissions to the ERP (it already holds the intake key) | script below |

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
`Pending Delivery/Service`, `Pending Review`).

> `Pending Review` is new to the sheet's stats block — add a row for it
> there if you want it counted (the retired-stage rows can be removed once
> the first sync has run).

## Apps Script (paste into the existing sheet-bound project)

```javascript
// ── ERP → sheet ASSR status sync ─────────────────────────────────
// Add to the SAME Apps Script project that posts form submissions to
// the ERP. INTAKE_KEY must be the same value the form POST sends in
// its X-Intake-Key header.

const ERP_STATUS_URL =
  "https://erp.houzscentury.com/api/assr-form-intake/status-export";
const ASSR_TAB = "ASSR Case (Farra)";
const DATA_START_ROW = 16;

function syncAssrStatus() {
  const res = UrlFetchApp.fetch(ERP_STATUS_URL, {
    headers: { "X-Intake-Key": INTAKE_KEY },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    console.error("status-export HTTP " + res.getResponseCode());
    return;
  }
  const payload = JSON.parse(res.getContentText());
  const cases = payload.cases || [];
  if (!cases.length) {
    console.warn("status-export returned 0 cases — aborting, sheet untouched");
    return;
  }

  // Index: by ASSR no, and by SO no (may hold several cases).
  const byAssr = {};
  const bySo = {};
  cases.forEach(function (c) {
    if (c.assr_no) byAssr[String(c.assr_no).trim()] = c;
    if (c.so_no) {
      const k = String(c.so_no).trim();
      (bySo[k] = bySo[k] || []).push(c);
    }
  });

  const sh = SpreadsheetApp.getActive().getSheetByName(ASSR_TAB);
  const lastRow = sh.getLastRow();
  if (lastRow < DATA_START_ROW) return;
  const n = lastRow - DATA_START_ROW + 1;
  // A..E = status, SO NO, ASSR NO, date, Ref No
  const rows = sh.getRange(DATA_START_ROW, 1, n, 5).getValues();

  let updated = 0;
  const statusCol = rows.map(function (r) {
    return [r[0]];
  });
  rows.forEach(function (r, i) {
    const so = String(r[1] || "").trim();
    const assr = String(r[2] || "").trim();
    const ref = String(r[4] || "").trim();
    let hit = (assr && byAssr[assr]) || null;
    if (!hit && so && bySo[so]) {
      const list = bySo[so];
      if (list.length === 1) hit = list[0];
      else if (ref)
        hit =
          list.filter(function (c) {
            return c.ref_no && String(c.ref_no).trim() === ref;
          })[0] || null;
      // several cases on the SO and no Ref match → leave the row alone
    }
    if (hit && hit.status && String(r[0] || "").trim() !== hit.status) {
      statusCol[i][0] = hit.status;
      updated++;
    }
  });

  if (updated) {
    sh.getRange(DATA_START_ROW, 1, n, 1).setValues(statusCol);
  }
  console.log(
    "ASSR status sync: " + updated + " row(s) updated of " + n +
    " (ERP cases: " + cases.length + ")"
  );
}

// Run ONCE to (re)install the 10-minute trigger.
function setupAssrStatusTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "syncAssrStatus") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncAssrStatus").timeBased().everyMinutes(10).create();
}
```

## Install (one-time, ~2 minutes)

1. Open the HC Delivery sheet → **Extensions → Apps Script** (the project
   that already contains the form-intake POST).
2. Paste the block above into a new file (or below the existing code). If
   the existing code doesn't already define `INTAKE_KEY`, add
   `const INTAKE_KEY = "<the same key the form POST uses>";`.
3. Run `syncAssrStatus` once from the editor — check the log says
   `N row(s) updated`, and spot-check column A against the ERP.
4. Run `setupAssrStatusTrigger` once — that installs the every-10-minutes
   trigger (visible under the clock icon → Triggers).

## Notes

- Read-only on the ERP side; the endpoint returns no customer PII (the
  sheet already holds the customer columns — the sync never touches them).
- The sync only ever writes column A. Manual edits to any other column are
  never overwritten; manual edits to column A on a **matched** row are
  overwritten within 10 minutes (the ERP is the source of truth — change
  the stage in the ERP instead).
- Rows that never became ERP cases keep their hand-keyed status forever.
