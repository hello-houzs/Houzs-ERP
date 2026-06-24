# Houzs SO — Payment & OCR Spec

Owner-specified, captured 2026-06-24. Single source of truth for the consolidated
Payment-Method + OCR (scan-so + scan-payment) wave. Implement AFTER the in-flight
scan-so quality workflow lands (to avoid concurrent edits to the same files).

---

## 1. Payment Method model — 3 top-level methods

Top-level `payment_method` = **Merchant, Online, Cash** (drop "Installment" as a
top-level method — installment is the *plan under Merchant*, not a method).
These are wired-to-order-logic core methods, so reduce the protected list 4 -> 3
in the backend + seed (not just deactivate the config row, or the guard re-adds it).
There are currently **0 payment rows** in `scm.mfg_sales_order_payments`, so this is
a zero-data-migration change.

Per-method required sub-fields (the Payments cascade on New SO / SO Detail):

| Method | Requires |
|---|---|
| **Merchant** | (a) Bank = `merchant_provider`; (b) Plan = `installment_months` (One Shot, or 3/6/12/24/36 months) |
| **Online** | Sub-Type = `online_type` (Bank Transfer / TNG / Cheque / DuitNow) |
| **Cash** | nothing extra |

Config tables (`scm.so_dropdown_options`): `payment_merchant` (banks),
`installment_plan` (One Shot + 3/6/12/24/36 months), `online_type` (the 4 sub-types).

---

## 2. scan-payment OCR — card-terminal receipt -> payment row

Read a card terminal receipt photo and map to a payment row:

- **Amount** -> `amount_centi` (Maybank RM4600.00 -> 460000; AEON TOTAL RM1500.00 -> 150000).
- **Approval / APPR CODE** -> `approval_code` (Maybank 073496; AEON 046501).
- **Swipe date on the receipt** -> `paid_at`. **THIS CAN BE A PAST DATE** — the
  salesperson may open the SO 2-3 days after collecting the money. Use the receipt's
  DATE/TIME, NOT today.
- **Months / Tenure:**
  - Receipt shows "Tenure: N Months" / IPP / installment (e.g. AEON Credit, 12 Months)
    -> Method = **Merchant**, `installment_months` = N (e.g. 12). AEON = installment route.
  - **No months** on the receipt (e.g. a Maybank Merchant swipe) -> **One Shot**
    (`installment_months` = "One Shot"), Method = Merchant.
- **Bank / Host** -> `merchant_provider` (Maybank "Host: MBB" -> MBB; AEON terminal -> AEON).
  See Open Question on banks not in the list.

---

## 3. Processing / Delivery date

- **Processing date** = when the order is "proceeded" (procurement starts). Some
  customers aren't ready for delivery yet, so the order may sit un-proceeded.
- On create / scan, default:
  - If a **Delivery date** is set: `Processing = max(today, Delivery − 6 weeks)`.
    (Delivery far out -> proceed ~6 weeks before, not too early -> don't buy stock too soon.
     Delivery soon / within 6 weeks -> proceed today. Never a past date.)
    Example: Delivery Jun 1 -> Processing ~Apr 15.
  - If **no Delivery date**: `Processing = today`.
- Reconcile the "Processing Date and Delivery Date must be set together — Save is
  blocked" guard so auto-seeding Processing keeps Save unblocked (Delivery stays optional).

---

## 4. Address — Google Maps assist

- Postcode is the driver: picking a **postcode** auto-cascades **city + state** (localities).
  Do NOT hard-set city/state independently.
- Use Google (Places/Geocoding) to match the customer's **condo / taman / jalan** name
  to the nearest real place -> resolve the precise **postcode** -> the cascade fills
  city/state. Goal: nail the taman/jalan/condo + postcode; the rest follows.
- Fail-soft: if the key is missing or geocode fails, fall back to the LLM parse (no crash).

---

## 5. scan-so line items (in-flight workflow)

- Match every slip line against the **FULL** catalog (un-truncated, ~1141 SKUs).
  Aggressive fuzzy / abbreviation match: "holes" -> AKEMI SLEEP ESSENTIAL 7 HOLES PILLOW;
  "W. Protector (King)" -> WATERPROOF PROTECTOR King; "Guardian (King)" -> Guardian model
  + King size; "bolster" -> AK-ESSENTIAL BOLSTER. Never invent a code not in the master.
- Line item product field is **ALWAYS a SKU dropdown** — never free-text. A no-match line
  = an empty **required** dropdown the user must pick from. No back-door insert.
- Phone -> +60 without the leading 0. Notes -> only the essential order remark (not a dump
  of venue / other phones / delivery terms / payment). Per-line "Slip: ..." annotation -> short.

---

## Open question — bank list is incomplete

`payment_merchant` is seeded with 6 (MBB / CIMB / Public / HLB / Alliance / Pinelabs),
but the field's own hint lists 9 (… RHB / Bank Islam / BSN / AmBank …) and these receipts
need **AEON** (issuer HSBC). Decide how a receipt bank not in the list maps:
add the missing banks (+ AEON/HSBC), have the OCR pick the closest, or leave it blank for
a manual pick. Recommendation: seed the full intended set + AEON, leave unknowns blank for manual.
