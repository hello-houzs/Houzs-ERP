# Houzs ERP · Mobile — Change Log / Prompt Log

A running record of every request made during the mobile-app design sessions and what was delivered for each. Newest work is cumulative — the single deliverable is **`houzs-mobile.html`** (self-contained app; assets in `assets/`).

> Handoff note for Claude Code: `houzs-mobile.html` is a standalone vanilla-HTML/CSS/JS prototype (no build step, no framework). `Houzs Mobile (standalone).html` is the same app with all assets + fonts inlined into one file — open it directly or pass it straight to Claude Code to regenerate/port. `support.js` is the Design-Component runtime used by the project's `.dc.html` files (the mobile app itself does not require it).

---

## Screens in the app
Login · Calendar · Sales Orders (list / detail / new+edit / OCR scan) · Profile (+ Personal details / Notifications / Language / Help & Support / My Team) · Project (PMS) · Service Case (+ creation) · **Delivery Planning** (run sheet + stop detail, for Delivery / Service / Project-Fair) · Mail Center (list / thread / compose) · Announcements (list / detail / new) · Inbox (in the center menu) · plus generic list+detail screens for every menu module (Delivery Orders, Sales Invoices, Returns, MRP, PO, GRN, PI, Purchase Returns, Products, Suppliers, Fleet, Drivers, Warehouse, Inventory, Members, Positions, Departments).

Bottom tabs: **Orders · Service · (center Menu) · Calendar · Profile**.

---

## Prompt log

### Foundation & navigation
1. **Menu items all crammed together** → regrouped the slide-up menu into bordered per-module panels.
2. **Complete pending tasks / nav audit** → wired every `show()` target; no dead links.
3. **Remove the generic Home; each position has its own home** → removed Home; default landing is now Login → Orders.
4. **Bottom tab + profile icons look bad** → unified tab icons to one line-icon set; replaced the cramped "FR" avatar with a clean user icon. Tabs: Orders · Calendar · (center Menu) · Inbox · Profile.
5. **Inbox & Profile tabs were dead** → built a notifications **Inbox** feed (unread dots, "Mark all read", badge) and a **Profile** screen.
6. **Center menu button** → opens the full grouped module menu; added then (on request) **removed** the "Menu" text label; kept the standalone center button.
7. **Menu regroup by real modules** → Sales & Finance · Projects · PMS · After-sales · Procurement & MRP · Logistics · Warehouse · Organisation.
8. **Removed** Lease and Finance menu items + pages (not needed).

### Login
9. **Add Remember me + premium feel** → Remember-me toggle; staggered entrance animation; drifting aurora glows.
10. **Login blank** → fixed (entrance animation was never triggered); added reduced-motion fallback so content always renders.
11. **Logo is generic / not ours** → replaced the invented bars-mark with the real **Houzs Century** logo (`assets/logo-mark.png`), used on login + header lockups.
12. **Want gentle full-screen ambient animation (snow), not a flashing logo** → added a slow drifting particle canvas; removed the logo sheen/flicker.

### Visual system
13. **Black isn't a true black (for Dark/Light mode later)** → retuned all dark surfaces from green-tinted `#13201c` to neutral near-black `#15161a`.
14. **The "0" and numbers look ugly** → dropped IBM Plex Mono for figures; numbers now use tabular Sans with the slashed-zero disabled (clean, still aligned).

### Sales Orders
15. **Filter button did nothing** → wired it to a filter sheet (date range + status) with an active-filter indicator.
16. **Filter by this/last/next month + this year, by order date; lighter list; show Processing & Delivery dates** → done; rows are lighter and show Proc → Deliv.
17. **OCR scan: 2 photos → submit → runs in background → drafts appear; scan several in a row** → built the scan screen + background drafting queue.
18. **Phone +60 prefix (customer + emergency)** → added the +60 field prefix.
19. **Payments per desktop: Date / Method / Amount / Account Sheet / Approval Code / Collected By** → reworked the payment card to match.
20. **Line items: per-item delivery date + photo; stop cramming Unit Price/Amount** → added delivery date + photo capture; amount shown once, compact.
21. **Bedframe variant UI** → grouped the Divan/Leg/Gap + total-height build into a clean panel.
22. **Draft vs Submitted edit modes** → Draft → "Edit Draft" + Create; Submitted → Edit + Cancel.
23. **Cancel (void) order button** → added with confirm.

### Calendar
24. **Desktop calendar has far more** → rebuilt: month nav + Today, Month/Week, All brands / sections / organizers filters, Tasks / My holidays / Expand all toggles, legend, dense event bars with "+N more".

### Project (PMS)
25. **Role-based permissions; PIC + Sales attending; stage details; period (no codes/sales/margin for ops roles); tasks; stock transfer; setup/dismantle photos; 3D floor plan; P&L; rental; print** → built the full PMS detail: 9-stage pipeline, "View as" role gate (hides Sales & P&L for ops roles), Project detail, team, tasklist sections, setup/dismantle dates + drivers + photos, floor plans (3D + filled/unfilled), stock-transfer upload, rental status, finance snapshot, print.

### Service Case
26. **Creation (attachments, priority, category, description, SO lookup) + full case card + filter/search** → built the New Service Case form and the rich detail: status/priority/lead-time/overdue chips, 9-stage workflow pipeline, Issue, Product Info + PO, Issue Inspection, Resolution + supplier pickup, QC Inspection, Reference & Logistics, Customer, PIC, SLA, Timeline (audience tabs + add note), Print copies (Customer/Supplier/Office), Portal link.

### Mail Center
27. **Make it a real email client incl. create / reply / forward** → folders (Inbox/Starred/Sent/Drafts/Archive), mailbox switcher, search, label chips, thread reader (avatars, attachments), and context-aware compose: New / Reply / Reply all (prefilled recipient + "Re:" + quote) / Forward ("Fwd:" + quoted thread).

### Announcements
28. **View-only on mobile; who creates?** → made it read-only with a "published by … · view only" note.
29. **Show covers + add Create New** → rebuilt as a module: cover images on every card + detail, and a **New announcement** compose (cover upload, title, audience, body, publish).

### Profile
30. **Build out the rows (Personal details, Notifications, Language, Help & Support)** → real sub-screens for each.
31. **Logout missing / can't click** → "Log out" with confirm; fixed it being hidden behind the floating tab bar (forced bottom clearance on root screens).
32. **My Team for salespeople = downline + reporting line** → dedicated My Team screen: upline reporting chain (→ YOU) + downline list with per-rep MTD sales.

### Bottom navigation & polish (latest)
33. **Refine the nav bar (looks cheap — font or icons?)** → lightened the labels (was 8.5px wide-tracked uppercase → 9.5px sentence-case), unified all icons to one 1.7-stroke set (Orders = clean folded-corner doc), added a soft active-pill highlight behind the active icon, springy icon transitions, and a gradient center disc with a ring + press states.
34. **Rename PROC / DELIV** → the SO-list date labels now read **Processing / Delivery** in full.
35. **Calendar filters went missing** → restored the full calendar chrome (month nav, Month/Week, brand/section/organizer filters, Tasks/Holidays/Expand toggles, legend) that had been hidden.
36. **Change bottom tabs to Orders · Service · Calendar · Profile** → reordered; Service (wrench icon) opens Service Cases; Inbox moved into the center menu (unread badge kept on the menu item).

### Delivery Planning (driver / helper run sheet)
37. **Show the delivery time window on the cover (not just "Delivered"); detail was empty** → cover now shows the **time window** colour-coded by status; rebuilt the stop detail with full data.
38. **Late status** → if the current time is past the window end, the cover shows a red **Late** state and the detail shows a red banner.
39. **3-state tracking** → On the way (出发) → Arrived (到达) → Complete (POD / photos), each stamping a time.
40. **Emergency contact** → collapsible “tap to view” block with a call button (a second/family number).
41. **Three job kinds** →
    - **Delivery** — goods with specs, house type, move (new/existing home), disposal flag, setup photos + 3D, sales & references (SO/DO/Ref/Brand), balance-to-collect (drivers see **balance only, never the total**).
    - **Service** — Pickup vs Delivery; problem + resolution cards (not item-focused), product under service, service documentation (report + on-site photos), contact + emergency.
    - **Project / Fair** — Setup Fair vs Dismantle Fair; **venue-based, no balance**; title-led cover; organizer + site PIC; Floor plan / 3D / Layout drawings; multi-spot photo groups (Overall booth, Dispenser station, Signage, Lighting, …).

### Typography
42. **Unify sizes/fonts for mobile** → unified all light-screen titles to 20px and normalised the header/body/eyebrow scale across screens.

---

## 2026-07-02 build session — shipped to prod (sw v93 → v97)
Design-relevant changes made while wiring screens to the real backend. Update
the matching `mobile-react-design/*.tsx` when you redo a screen so this stays
the current-state reference.

### Orders — SO card (MobileSoList)
43. **SO card re-designed → owner-locked 4-line layout.** Line 1: customer name + phone (accent) · order-status badge (right). Line 2: `SO-no · Ref` (values only, no "SO"/"Ref" labels) · **warehouse** name far right (no icon). Line 3: `Processing {date} → Delivery {date}` (labels spelled in full, left) · **Stock chip** + **Delivery-planning chip** (right). Line 4: `Balance` (left) · total (right, bold). No customer-state line (warehouse implies region). Chips: Stock ready=green / pending=grey; Planning pending-schedule=amber / pending-delivery=grey / overdue=red / delivered=green. Warehouse + planning come from the backend list (`warehouse_name` / `planning_state`).

### Sales Order — scan (MobileScan / MobileNewSO)
44. **Payment slip → multiple.** The Scan "Payment slip" tile now takes MANY photos; each slip = one payment (an order can take 2–3). Front slip stays single. New-SO seeds one payment row per slip.

### Service Case (MobileServiceCase)
45. **Removed the duplicate "REPORTED ISSUE" banner** — the complaint shows once, as the editable Complaint field in the Issue accordion.
46. **Add product → picker of AVAILABLE items** (from the case's SO), not free text; the "+ Add item" action is HIDDEN when nothing is available to add.
47. **Customer section completed** — added Ref No + Address (Email already editable).
48. **Resolution → Customer pickup date** added beside Supplier pickup date (go-to-customer vs go-to-supplier).
49. **Edit buttons** sit at the far right of each section header (were floating mid-row). **Bottom padding** increased so content clears the tab bar.

### Font
50. **Mobile font aligned to desktop** — dropped the unloaded "IBM Plex Sans" from the `.hz-m` stack (it was falling back to an ugly serif); now the desktop system-ui stack.

### Calendar (MobileCalendar)
51. **Filters wired to real data** (brands / sections / organizers endpoints); the mislabeled "All venues" is now "All sections". **"+N more"** opens that day's detail sheet. **Tapping a date** (or a holiday) opens a **DaySheet** listing that day's projects, tasks, and public holidays.

### Announcements (MobileAnnouncements)
52. Attachment upload confirmed present (photo/video + PDF); the Document picker was narrowed to PDF (backend accepts images/pdf/video only).

### Delivery Planning (DESKTOP board — SCM, not the mobile run-sheet)
53. **Excel-style inline editing** — click a cell to set Status / Sched. date / Driver / Lorry in place (no drill-in); each persists immediately. **Compact bulk-edit bar** appears when rows are ticked: `N selected · Set [field] → [value] Apply` (the value control's type follows the field). Manual status override wins over the auto state; the Stock column still shows real readiness.
54. **Dated Service Cases surface on the board.** A service case appears ONLY once it has a date (Customer pickup date or Delivery/DO date); empty = hidden. A new **Type** column tags each row: `SO delivery` / `Cust. pickup` / `Delivery`. Service rows open the case (not an SO); editing the date writes back to the case. Grouped by region like SOs; lands in Pending Delivery.

### Sales Order Maintenance (DESKTOP) + regions
55. Per-state **Region** multi-select column added (state → delivery-region buckets) beside the Warehouse column.

### Project Maintenance (DESKTOP)
56. The 6 config managers (Brands, Event Types, Organizers, **Venues**, Cost Rates, Checklist) are now **collapsible** sections with count badges (Brands open by default) — kills the long scroll.

### Profile (MobileProfile)
57. The two stat tiles now match the v7 design's **Orders MTD / Sales MTD** (previously placeholder "Open cases / Points"). Wired to a new self-scoped SCM endpoint `GET /api/scm/mfg-sales-orders/my-mtd` — the caller's OWN sales orders created this Malaysia-calendar month (count + summed value, excluding CANCELLED/DRAFT). A non-sales user sees 0 / RM 0.00.

### Service Case (MobileServiceCase)
58. **New case now appears in the list immediately** — after a successful create the cases-list query is force-refetched (`invalidateQueries … refetchType: "all"`) so the just-created case is present whether the user lands on the detail page and taps back, or returns to the list.
59. **Complaint date field added to the New Service Case form** — a native date input in the Issue card (numeric DD/MM/YYYY, value `YYYY-MM-DD`), defaulting to today (MYT) and capped at today. Sent as `complained_date` and written to `assr_cases.complained_date` (the backend honours an explicit valid value, else falls back to today).
60. **Issue row removed from the cases-list card** (owner: the full complaint made each card too tall). The `.so-grid` card now shows only Case · Item · SLA; the complaint text is still searchable and still shown in full on the case detail. Keeps the list scannable.

### New/Edit SO polish batch (2026-07-04, sw v118)
61. **Customer Type defaults to "New Customer"** on a NEW SO — matched case-insensitively against the real `so_dropdown_options` rows (falls back to the first option); EDIT keeps the persisted value; a scan-provided type wins.
62. **"Fill in address later" checkbox removed.** The delivery address is simply optional: left empty it saves empty.
63. **Address-required rule** — Customer Name + Phone stay the only always-required fields, BUT once BOTH a Processing date AND a Delivery date are set, State + City + Postcode + Address Line 1 become required (inline per-field errors + a plain-sentence blocker naming exactly what is missing).
64. **Equal-width action buttons** — Save draft / Create Sales Order are a balanced 50/50 pair (`flex: 1 1 0` + shared 48px height).
65. **Line item shows the product Code only** (the long name was squeezed to an unreadable truncation in the narrow row).
66. **"Record Payment" renamed "Add Payment"** in the SO detail (both the payments-card link and the action button) — payment recording lives inside the Sales Order, per the owner's flow.
67. **Special orders accordion on SO lines (bedframe + sofa)** — owner-approved mockup. Collapsed "Special orders · N selected" row under the variant selects; expanding lists the Model's allowed `special_addons` as checkboxes with a display-only `+RM` (sellingPriceSen). Ticking writes `variants.specials` + `specialChoices` (required option-groups default to their first choice) + `specialLabels` — the exact desktop SoLineCard vocabulary, so the server honest-pricing recompute prices them. Pool = active addons for the line's category ∩ the Model's `allowed_options.specials` ticks (POS semantics: no ticks = nothing offered). Auto-opens on edit when the line already carries specials; a saved special the Model no longer offers still shows as an untickable-ghost row so edits never hide what the order carries.
68. **Catalog caching** — `useMfgProducts` now caches 5 minutes with `keepPreviousData`, so the SKU picker no longer blanks to "Loading Catalog" on every open/keystroke (vendored perf deviation, commented in-file).
69. **Scan now uploads and finishes in the background** — the Scan screen POSTs to the new `/scan-so/enqueue` (photos + salesperson) and returns in seconds; the OCR + DRAFT SO create run server-side (`ctx.waitUntil`, `scm.scan_jobs`), so the operator can close the app immediately. Toast wording updated ("Order uploaded ... you can close the app"); the Orders list re-nudges at 2.5s/45s/120s so a finished job's draft surfaces without a reload. The legacy on-screen flow is kept verbatim as the automatic fallback when `/enqueue` is not served.
70. **Venue is editable on the SO form** — a real select fed by the venues master; default stays the auto-derived value (salesperson's project), picking "—" reverts to auto; the auto-fill hint hides once overridden. **Specials price noise removed** — the "+RM 0.00" suffix only renders for non-zero configured prices. **Hairline dividers** — line/pay/specials card inner borders standardized to the `--line2` token (#eceee9).

---

## Full rebuild to Build Spec + prototype (2026-07-03, sw v107–v109)

The mobile app had been built largely from the **simplified `react-tsx/` port**, which diverged from the owner's authoritative sources — the **Build Spec** (`Houzs ERP Mobile - Build Spec.html`) and the **prototype** (`houzs-mobile.html`). Owner caught the drift ("为什么你没看完我的file?"). Every screen was re-reconciled against Build Spec + prototype + react-tsx **together** (prototype + Spec authoritative; react-tsx = React-structure reference). Governing rule: **"全部跟着后端"** — where the design shows a field/axis the backend lacks, follow the real backend (omit/em-dash), never fabricate option lists. PRs #222/#223/#224.

58. **Shell** — center menu disc icon is the prototype's **4-square grid/apps icon** (was a hamburger copied from the simplified mock).
59. **SO list** — added the **summary bar** (`N orders · RM rev · RM outstanding`), **period filter chips** (All / This / Last / Next month / This year), warehouse label + Stock/Planning chips (shown only when the row carries the status), `created` date, and a floating **+ FAB** (was a header +).
60. **SO detail (Job Card)** — confirmed it is the New-SO form rendered **locked** (`.fld-ro`) with a KPI money strip + status action bar; added emergency-contact row, `· uom`, and a `description2` variant-spec fallback.
61. **New/Edit SO** — rebuilt into the Spec's **5-step wizard** (Customer · Order info · Items · Payment · Review) with a progress bar + step-gated validation. Line **variant dropdowns rewired from hardcoded arrays to the REAL desktop data**: fabric ← `fabric-colours`/`fabric-library` (700+ colours), sofa seat/leg + bedframe **divan/leg/gap** ← `maintenance-config/resolved` (with real `priceSen`), per-SKU filtering ← `product-models/by-code`, required-axis gate ← the server's `missingVariantAxes`, computed **Total height = divan+leg+gap**. Method-aware payment step. **Follow-backend:** bedframe size/headboard/storage + mattress firmness/height are NOT SO-line axes in the real system, so they are not shown (prototype-only mock fields).
62. **Generic doc engine** (`MobileModuleList/Detail/Form`) — list card + locked-form detail + status action bar per module; added stock-transfers/stock-takes/regions/accounting/consignment-notes modules with real columns.
63. **Delivery Planning / POD** — prototype clock pill, address+postcode, "View & deliver", move-in/reference rows; balance-only (never total) preserved for driver/helper.
64. **Service / Calendar / Mail / Announcements / Inbox / Scan / Convert** — reconciled to prototype markup + numeric DD/MM/YYYY; fixed a phantom `product_category` → real `service_category`; Convert wizard is honestly 2-step (backend has no driver-assign step).
65. **PMS** — **follow-backend stage vocabulary**: filter chips + badge use the real `projects.stage` enum (**Draft / Setup / Live / Dismantle / Completed**), not the design's Planning/Live/Settled; numbered-dot pipeline; dark header.

**Verified live in-browser (v109):** SO Edit → Items step shows real Fabric (706)/Divan/Leg/Gap dropdowns from maintenance-config; PMS chips show the real backend stages.

---

## Still open (flagged, awaiting direction)
- **My Team depth** — single-level downline now; multi-level (reports-of-reports) optional.

---

## Backend / out-of-scope (tracked elsewhere)
SCM deployment, DB migrations, PDF/xlsx enablement, R2 uploads, and real API wiring live in the developer handoff package (`design_handoff_houzs_unfinished_pages/`), not in this mobile design file.
