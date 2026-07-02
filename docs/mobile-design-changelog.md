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

## Still open (flagged, awaiting direction)
- **My Team depth** — single-level downline now; multi-level (reports-of-reports) optional.

---

## Backend / out-of-scope (tracked elsewhere)
SCM deployment, DB migrations, PDF/xlsx enablement, R2 uploads, and real API wiring live in the developer handoff package (`design_handoff_houzs_unfinished_pages/`), not in this mobile design file.
