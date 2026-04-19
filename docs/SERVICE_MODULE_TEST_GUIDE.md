# Service Module — Testing Guide

A hands-on walkthrough for testing the **After-Sales Service Request (ASSR)** module. No technical background needed — just follow the steps in order and tick each box as you go.

> **Before you start**
>
> You'll need two browser windows open side by side:
> - **Window A — Staff side** — the normal Houzs ERP (signed in as a dispatcher or manager)
> - **Window B — Customer side** — an **incognito / private** window (so no staff session carries over)
>
> On Windows, press `Win` + `←` / `Win` + `→` to snap the windows side by side.
> On Mac, drag each window to the edges, or use the green maximise button → "Tile to Left/Right".

You'll also need:
- A **real Sales Order number** that has a customer phone on file. Keep it handy — we'll call it `TEST SO`.
- 3 test photos on your computer (any JPG/PNG images will do — even selfies or random pictures)

---

## 🗂 What this guide covers

The Service module follows a case from start to finish. This guide walks through every feature in the order a real case would go through it.

| Section | What you'll test |
|---|---|
| 1 | Create a new service case |
| 2 | Generate the customer's tracking link |
| 3 | Customer opens the link and sees the case |
| 4 | Move the case through the workflow stages |
| 5 | Customer comments and uploads a photo |
| 6 | Assign a supplier and generate a PO |
| 7 | Manager quality review |
| 8 | Close the case and collect satisfaction feedback |
| 9 | Print the official case report (PDF) |
| 10 | Archive the closed case |
| 11 | Customer uses the public tracking form |
| 12 | Check the Quality Metrics dashboard |

Each section has a ✅ checklist — tick the box when the expected thing happens. If something doesn't work as described, make a note of the section and step number and we'll investigate.

---

## 1 — Create a new service case

In **Window A (staff)**:

1. Click **Service** in the left sidebar.
2. Click the **New Case** button (top right, brown button).
3. Type your `TEST SO` into the box and click **Lookup**.
    - ✅ The customer's name, phone, and items appear below
4. Tick **one** item from the list.
5. In the **Issue Description** box type something like:
   > "[TEST] Sofa cushion torn at seams — customer reports 2 cushions affected"
6. Scroll to **Defect Photos / Videos** section.
7. Click **Add Photos / Videos** and select your 3 test photos.
    - ✅ Three thumbnails appear below
    - ✅ If you hover a thumbnail you can see a small × to remove it
8. Click the big **Create Case** button at the bottom.
    - ✅ A green notification says "Created ASSR/XXXX-XXX with 3 attachment(s)"
    - ✅ The side panel automatically opens with all the case details

**Write down the case number** (e.g. `ASSR/2604-015`) — we'll use it later. Let's call this `YOUR CASE NO`.

Take a look at the side panel:
- ✅ Status pill shows **Pending Review** (grey)
- ✅ A countdown pill on the right shows something like "168h left" (that's the deadline)
- ✅ Customer details match the SO
- ✅ Your 3 photos show in the Attachments section

---

## 2 — Generate the customer's tracking link

Still in the case detail panel:

1. Scroll to the section called **Customer Portal Link**.
2. Click **Generate Portal Link**.
    - ✅ A long URL appears in a grey box
    - ✅ The URL is already copied to your clipboard (a small "Copied" toast may appear)
3. **Close the side panel** (click outside or the X).
4. **Reopen the same case** by clicking the row.
    - ✅ The Portal Link is **still there** — you don't need to regenerate it

> 💡 In real life, this is the link you'd paste into WhatsApp to send to the customer.

Copy the URL — we'll use it in the next step.

---

## 3 — Customer opens the link

Switch to **Window B (incognito)**:

1. Paste the URL into the address bar and press Enter.
2. The customer portal loads.
    - ✅ You see the Houzs Century logo at the top
    - ✅ The case number is shown big and bold
    - ✅ Status shows **Pending Review** in grey
    - ✅ Customer name, issue description, and photos all visible
    - ✅ Timeline shows "Case received"
    - ✅ At the bottom there's a comment box and an Upload photo button

Also check the page looks good on your phone if you can:
1. On your phone, open the same link
    - ✅ Logo still fits, no squashed layout
    - ✅ Footer with company details is readable
    - ✅ Photos arrange nicely in the grid

---

## 4 — Move the case through the stages

This is where the work actually happens on the staff side.

Go back to **Window A (staff)** and open your case.

In the panel's bottom bar you'll see a blue button like **Start Verification**. Each click moves the case to the next stage.

### 4.1 — Start Verification
1. Click **Start Verification**.
    - ✅ Status changes to **Under Verification** (blue)
    - ✅ Activity timeline (scroll down) shows a new entry
2. Go back to **Window B** and reload the page (F5 or Cmd+R).
    - ✅ Customer now sees **Under Verification** (blue)

### 4.2 — Move to Solution
1. In Window A, click **Move to Solution**.
    - ✅ Status → **Pending Solution** (amber)
2. Reload Window B.
    - ✅ Customer sees **Pending Solution**

### 4.3 — Set NCR and service category
While still in Window A:
1. Scroll to **Issue & Resolution** section.
2. Click the **NCR Category** dropdown, pick "Workmanship".
    - ✅ Small tick or saving indicator briefly appears
3. Click **Issue Category**, type "Textile", press Tab.
4. Click **Resolution Method**, pick "Replace Unit".

### 4.4 — Assign Logistics
1. Click **Assign Logistics** (bottom bar).
    - ✅ Status → **In Progress** (purple)
2. Scroll to **Logistics** section → click **+ Schedule Pickup / Delivery**.
3. Fill in:
    - Type: Pickup
    - Date: tomorrow
    - Time: 10:00 AM – 12:00 PM
    - Notes: "[TEST] Collect from customer address"
4. Click **Schedule**.
    - ✅ A new row appears in Logistics with a yellow "pending" pill

---

## 5 — Customer sends a comment and a photo

Switch to **Window B (customer)**:

1. Reload the page. Status should now show **In Progress**.
2. Scroll to the bottom where it says "Add an update or question".
3. Type something like:
   > "[TEST] Can you confirm the pickup address? We moved last week."
4. Click **Post update**.
    - ✅ Your message appears in the Updates timeline with a **"You"** badge

Now upload a photo:
1. Scroll up to **Photos & evidence**.
2. Click **Upload photo** and pick any image.
    - ✅ The photo thumbnail appears with **"You"** label

Click on any photo thumbnail:
- ✅ A full-screen dark view opens showing the photo larger
- ✅ Use left/right arrow keys or the arrow buttons to flip through other photos
- ✅ Press Esc or click outside to close

Try removing your own comment:
1. Hover over your comment in the timeline.
    - ✅ A small trash icon appears on the right
2. Click it → confirm → the comment disappears
    - ✅ You can only do this to your **own** comments — staff comments don't show the trash

### Back to staff (Window A)
1. Close the side panel and reopen the case.
2. Scroll to **Activity** at the bottom.
    - ✅ New entry with purple-ish border and **"Customer"** badge
    - ✅ If the customer hadn't deleted their comment, you'd see the text
3. Scroll to **Attachments**.
    - ✅ The photo the customer uploaded appears with a darker "CUSTOMER" label

---

## 6 — Assign a supplier and generate a PO

Still in the staff panel for this case:

1. Scroll to **Resolution Plan** section → find **Supplier** dropdown.
2. Pick any supplier (or click **Suppliers** in the sidebar in another tab first to create a test one called "Test Upholstery").
3. Back in the case panel, under **PO No**, click **+ Auto-generate PO number**.
    - ✅ PO field fills with something like "APO/2604-001"
    - ✅ A new activity entry: "PO generated: APO/..."
    - ✅ The auto-generate button disappears
4. Scroll to **Cost Tracking**:
    - PO Amount: `450`
    - Invoice Ref: `[TEST] INV-001`
    - Cost Notes: `[TEST] Replacement foam + re-cover`

### Customer-side verification (important)
Go to **Window B** and reload.
- ✅ **No supplier name anywhere**
- ✅ **No PO number anywhere**
- ✅ **No cost values anywhere**

The customer should see nothing about suppliers or money. If any of that leaks through, stop and note it down — it's a serious issue.

---

## 7 — Manager quality review

Still in Window A, case detail:

1. Scroll to **Quality Review** section.
2. Click **Approve & Pass QA**.
    - ✅ The section turns green and shows your name + date
    - ✅ Activity timeline: "Quality review: Passed"
3. Click **Mark Ready to Complete** (bottom bar).
    - ✅ Status → **Pending Completion**

---

## 8 — Close the case and capture feedback

### 8.1 — Close the case
1. Click **Close Case** (bottom bar, big brown button).
    - ✅ Yellow prompt appears with 5 stars and a notes box
2. Skip the rating (leave all 5 stars grey) and click **Confirm Close**.
    - You're not the customer — the customer will rate later
    - ✅ Status turns green: **Completed**

### 8.2 — Check customer side
Switch to Window B, reload.
- ✅ Status shows **Completed** (green)
- ✅ The comment box at the bottom is **gone** (closed cases don't accept new comments)

### 8.3 — Send the customer a survey
Back in Window A, in the closed case:
1. Scroll to **Customer Satisfaction**.
2. Click **Generate Survey Link**.
    - ✅ A link appears and is copied to your clipboard
3. Copy the link.

### 8.4 — Customer submits feedback
Open the survey link in a **new** incognito tab (not the portal one).
1. Tap **4 stars**.
    - ✅ Label below the stars reads "Satisfied"
2. Type something like:
   > "[TEST] Fast response, very professional team"
3. Click **Submit Feedback**.
    - ✅ Big green checkmark and "Thank you for your feedback!"
4. Try reopening the same URL.
    - ✅ You see the thank-you screen again — can't submit twice

### 8.5 — Verify on staff side
Go back to Window A, reload the case.
- ✅ **Customer Satisfaction** section now shows 4 stars + the note
- ✅ Activity timeline: a new entry "Customer submitted satisfaction survey: 4/5"

---

## 9 — Print the case as PDF

Still in Window A, in the closed case:

1. Find the small **Print** icon near the top of the side panel (near the deadline pill).
2. Click it.
    - ✅ A new tab opens with a formal A4 document
    - ✅ Houzs logo and full company details at the top (letterhead)
    - ✅ "After-Sales Service Report" title in the middle
    - ✅ Customer details, items, issue, resolution all there
    - ✅ The photos are embedded
    - ✅ Footer at the bottom: "This is a computer-generated document..."
    - ✅ Dates shown as DD/MM/YYYY (e.g. 14/04/2026)
3. Click the brown **Print / Save as PDF** button in the top-right of that tab.
4. In the print dialog:
    - Destination: **Save as PDF**
    - Open More settings → **Untick "Headers and footers"** (this removes the browser-added URL line)
    - Click **Save**.
5. Open the saved PDF.
    - ✅ The letterhead repeats on every page if there are multiple pages
    - ✅ The computer-generated notice appears on the bottom of every page
    - ✅ Colours preserved (the brown accents, status pills, etc.)
    - ✅ No content overlapping the letterhead or footer

---

## 10 — Archive the closed case

Closed cases tend to clutter the list. Let's archive this one.

1. Still in the staff case panel, find the **Archive** button in the bottom bar.
2. Click it → confirm the pop-up.
    - ✅ The case panel now shows a grey "Archived" banner at the top
    - ✅ Going back to the Service list, the case is no longer visible
3. In the Service list, find the **Show archived** checkbox (top right).
4. Tick it.
    - ✅ Your archived case reappears — greyed out with an "Archived" pill
5. Click the archived case → panel opens → click **Restore** in the bottom bar.
    - ✅ The archived banner disappears; case is back to normal

Archive it again so we keep the test list clean. 🙂

---

## 11 — Public tracking form

The customer can also look up their case without the dispatcher-sent link.

In **Window B (incognito)**, open a fresh tab and go to:
```
https://houzs-erp.pages.dev/track
```
(Replace with your actual Houzs Pages URL if different.)

### 11.1 — Invalid lookup
1. Type a random case number like `ASSR/9999-999` + a random phone.
2. Click **View my case**.
    - ✅ After about half a second, a friendly error: "No matching case. Check the case number and phone."

### 11.2 — Wrong phone
1. Now type `YOUR CASE NO` + a wrong phone number.
2. Click **View my case**.
    - ✅ Same friendly error (intentionally — we don't hint which field was wrong)

### 11.3 — Correct lookup
1. Type `YOUR CASE NO` + the correct phone from the SO.
2. Click **View my case**.
    - ✅ Redirects straight to the case view, same as the dispatcher link did

---

## 12 — Quality Metrics dashboard

Only for managers and dispatchers. In Window A:

1. Click **Quality Metrics** in the sidebar (under Service).
2. Browse the dashboard.
    - ✅ Stat cards at the top: Total Cases, Completion %, SLA Breached, Avg Satisfaction
    - ✅ NCR Categories breakdown shows "Workmanship" (from step 4.3)
    - ✅ Resolution Method Mix shows "Replace Unit"
    - ✅ Monthly Trend bar chart has at least one bar
    - ✅ Supplier Performance table shows your test supplier
3. Toggle the period pills: **Last 30d** / **Last 90d** / **Last 12m**.
    - ✅ Numbers change accordingly

---

## 🏁 You're done!

If you ticked every ✅ in order, the Service module is working correctly.

### Cleanup (optional)
You can leave the test case alone — it's clearly marked `[TEST]` in all the fields. Or tell the development team which case numbers you used and they'll clean them up from the database.

### Quick issue report template
If something didn't match the expected result, copy this and fill it in:

```
Section: __ (e.g. 4.3)
Case number: __
Browser: __ (Chrome / Safari / Edge)
Device: __ (desktop / phone)

What I did:
1.
2.

What I expected:

What actually happened:

Screenshots:
```

---

## Cheat sheet — what each status colour means

| Status | Colour | Meaning |
|---|---|---|
| Pending Review | grey | Case just opened, no one has looked at it yet |
| Under Verification | blue | Someone is verifying the complaint details |
| Pending Solution | amber | Deciding how to fix it |
| In Progress | purple | Logistics scheduled, work happening |
| Pending Completion | purple | Work done, waiting for final sign-off |
| Completed | green | Fully closed |

## Cheat sheet — icons

| Icon | Meaning |
|---|---|
| 🔴 SLA pill | Past the deadline |
| 🟠 Esc pill | Case was auto-escalated because it went more than 24h past deadline |
| `5d` red pill | Stuck in the current stage for 5 days |
| Star ★ | Customer satisfaction rating |
| 📎 paperclip area | Attached photos / videos |
| 🗑 trash on hover | Archive / remove (soft delete — can be restored) |

---

## Need help?

Take a screenshot and send it to the dev team with the section number from this guide. 🛠
