# Error tracking for Houzs ERP — options, cost, and what leaves the building

**Written for the owner, 2026-07-22.** Plain language. Prices are USD per month as published by each vendor on 2026-07-22; every number below has a source, and the ones that could not be confirmed are marked **UNCONFIRMED** rather than rounded off.

---

## The short version

| | |
|---|---|
| **Recommendation** | **Sentry, on its free plan**, reached through code we wrote ourselves rather than Sentry's toolkit. |
| **Cost** | **USD 0/month.** Free plan covers our volume with room to spare. The first paid step is USD 26/month, and we would only reach it if we wanted more than one person logging in to the dashboard. |
| **Work still to do** | The code is written and merged in this PR, switched off. **One command, once.** |
| **What you do** | Sign up at sentry.io, copy the "DSN" it gives you, and run one command (§7). Nothing before that changes anything. |
| **What you can undo** | All of it, instantly. Delete the secret, redeploy, and the ERP is exactly as it is today. |
| **The catch, stated up front** | Sentry stores data in the **United States or Frankfurt — there is no Asian option**, and the choice is permanent per account. That is why the code is written the way it is: it also speaks to **GlitchTip**, a free open-source alternative that can run on our own server, and switching between them is a change of one secret, not a change of code. §6 covers this. |

---

## 1. Why this is worth doing at all

On 5 July the ERP was down for **18 hours and 15 minutes**. Nobody was told. We only know the exact duration because an unrelated hourly job happened to write the failures into its log, and we read that log sixteen days later. The full write-up is in `docs/supavisor-pooler-outage-coe.md`; its conclusion is one sentence:

> "Nothing watches production between deploys."

Today, when something breaks in the ERP:

- **Backend failures** are written to a Cloudflare log that keeps three days of history, that nobody reads, and that raises no alarm.
- **Frontend crashes** (a white screen on a staff member's laptop) are already captured — we built that ourselves — but they arrive as **one email at 2am the next morning**. That is `backend/src/services/clientErrors.ts`, and it works. It is just a day late.
- **Nothing** tells anyone that error volume has suddenly gone from two a day to two thousand an hour.

The missing piece is not *capturing* errors. It is **grouping them, keeping them longer than three days, and sending someone a message within minutes** when the volume jumps. That is what an error tracker is.

**One thing an error tracker will still not do**, and it should be said now rather than discovered later: if the ERP is *completely* unreachable — the Worker never runs at all — there are no errors to send, so nothing fires. Catching that needs an uptime check pinging the site from outside. That is free, takes ten minutes, and is covered in §8 as a companion, not a substitute.

---

## 2. Where the real risk is: customer data

This is the part that matters more than the price.

The ERP holds real customer names, phone numbers, delivery addresses, prices and payment records. An error report is generated at the exact moment something goes wrong — which is to say, in the middle of handling one of those records. Error tracking tools, **by default, attach the request to the report**: the URL including its search terms, the request body, the cookies, the login headers, and the user's IP address. That is not a hypothetical. Sentry's own Cloudflare quick-start snippet ships with the data-collection options present and the opt-outs commented out:

```ts
dataCollection: {
  // userInfo: false,
  // httpBodies: [],
},
```

Paste that into our Worker as written and **customer request bodies, cookies and IP addresses start flowing to a third party**, on the first deploy, with nothing on screen to indicate it.

That single fact drove the whole design of what we built:

**We do not use the vendor's toolkit. We build the report ourselves, field by field, and a test asserts what is in it.** The vendor's toolkit works by attaching everything and letting you subtract; ours attaches nothing unless a line of our own code adds it. The difference is that one is a configuration you can get wrong quietly, and the other is a list you can read.

### 2a. Exactly what leaves the building

This is the complete list. Nothing else is sent, because our code never reads anything else.

| Sent | Example | Why |
|---|---|---|
| Error type and message, **with values redacted** | `duplicate key ... Key (phone)=([redacted])` | The message is the diagnosis |
| Stack trace: file, function, line number | `at SalesList (index-abc.js:1:2)` | Points at the broken code |
| The **route pattern** | `/api/scm/sales-orders/:id` | Which screen. Note it is the *pattern* — never the real address, so no record ids and no search terms |
| HTTP method and status | `POST`, `500` | |
| Our own request id | `a1b2c3...` | Ties the report back to our own Cloudflare log |
| Staff member's **numeric id** | `42` | So we can see "this hit three different people" |
| Company id, environment, build id, timestamp | `7`, `production` | |

**Never sent, at all:**

- Request bodies — no customer record ever travels
- Query strings and search terms
- HTTP headers of any kind, cookies, session tokens, `Authorization` values
- Customer names, phone numbers, addresses, prices
- Staff names, emails or usernames — the id only
- **The staff member's IP address.** Two separate reasons it cannot leak: browser crashes are forwarded **by our server**, not by the browser, so the tracking service only ever sees a Cloudflare address; and every report explicitly sets the IP field to null so the service does not fill one in itself.

### 2b. Redaction of the message text

The one field an outside library can stuff customer data into is the error message itself. Postgres in particular quotes the offending value back at you: `Key (phone)=(0123456789) already exists.` So message text is filtered before it is packed:

| Pattern | Becomes |
|---|---|
| `Key (column)=(value)` | `Key (column)=([redacted])` — the column name is the diagnosis and stays |
| Anything shaped like an email address | `[email]` |
| Any run of 8 or more digits (phone, IC, bank account, card) | `[number]` |

Short numbers survive, because "row 42 of 100 failed" is useless without them. The 8-digit rule does also catch dates written as `2026-07-22`; that is a deliberate, minor loss — the report carries its own timestamp.

`backend/tests/errorTracking.test.ts` asserts all of the above, including the negatives: it takes a realistic Postgres phone-number leak and requires the digits to be absent from the packed report.

---

## 3. The options, side by side

Every option here works with our stack (Cloudflare Workers backend, React app on Cloudflare Pages). Sources are listed in §9.

| | **Sentry** | **Cloudflare's own** | **GlitchTip** | **Better Stack** |
|---|---|---|---|---|
| **Free tier** | 5,000 errors/mo, **1 user only**, 30-day history | Logs only: 200,000 log lines/day, **3-day** history | Hosted: 1,000 errors/mo, unlimited users. Or self-host, unlimited | 100,000 errors/mo, unlimited users **(UNCONFIRMED)** |
| **Cheapest paid** | USD 26/mo (annual) — 50k errors, unlimited users, 90-day history | USD 5/mo Workers Paid → 7-day history | USD 15/mo — 100k errors. Self-host: server cost only | ~USD 30/mo |
| **Groups errors into issues** | Yes, best in class | **No** — raw log lines only | Yes (Sentry-compatible) | Yes |
| **Alerts you when errors spike** | **Yes**, email/Slack, minutes | **No.** Cloudflare has no Workers error alert at all | Yes | Yes |
| **Sees frontend (browser) crashes** | Yes | **No. Not possible** | Yes | Yes |
| **Where the data lives** | US or Frankfurt. **No Asia.** Fixed forever at signup | Stays on Cloudflare | Frankfurt, **or our own server** | Includes **Singapore** |
| **Work to wire in** | **Already done in this PR** | Nothing to wire, but it does not do the job | **Already done** — same protocol | Would need new code against their own API |
| **When the free quota runs out** | Events dropped silently. **No bill.** | Cloudflare bills per million past the cap | Dropped | Bills per event past the cap |

### What each one actually cannot do

**Sentry** — cannot store data in Asia; the region is chosen once at signup and cannot be changed afterwards (you would have to create a new account). The free plan is genuinely **one seat**: alerts go to one email, and one person logs in. It cannot un-minify our frontend code unless we also upload "source maps" at build time, which we do not do today — so frontend stack traces will name `index-abc.js` rather than `SalesList.tsx`. That is exactly what our current 2am digest already gives us, so it is not a regression, just not an improvement.

**Cloudflare's own tooling** — this was the option I most wanted to work, because it adds no third party at all, and we already have it switched on. It fails on two hard points, both verified rather than assumed:

1. **There is no alert.** Cloudflare's notification catalogue has no entry for Workers errors of any kind. Logs are query-only: you go and look. Nobody was going to go and look for eighteen hours, which is the entire problem.
2. **It cannot see the frontend.** Every Cloudflare logging surface records only what happens inside the Worker. A white screen in a staff member's browser is invisible to it, permanently.

There is a workaround — a "Tail Worker" that reads the log stream and sends its own alert email — but that requires the Workers **Paid** plan and means writing and maintaining our own alerting engine. That is more work than what this PR does, for less.

**GlitchTip** — the hosted free tier is only 1,000 errors a month, which one bad afternoon would exhaust. Self-hosting is genuinely free and keeps every byte in-house, but it means running a Postgres database and a server that has to stay up — and a monitoring system that goes down with everything else is worth less than it looks. No session replay, no profiling.

**Better Stack** — on paper the best free tier here and the only one with a Singapore region, which is why it is on this list. Two reasons it is not the recommendation: their published free error-tracking figures could not be confirmed against the product itself (marked UNCONFIRMED above, and this document exists partly so a wrong number does not drive a spending decision), and they have no Sentry-compatible ingest, so it would need new code written against a proprietary API instead of the protocol two other products already speak. **Their free uptime monitoring is a different matter, and I do recommend it — see §8.**

**Two products you may find recommended elsewhere, which are dead:** Highlight.io's hosted service was shut down on 28 February 2026 after LaunchDarkly acquired it. Baselime was bought by Cloudflare and folded into the Cloudflare tooling above; its website still shows a signup page, which is stale. Do not sign up for either.

---

## 4. The recommendation, and why

**Sentry's free plan, reached through our own code.**

1. **It solves the actual problem.** Grouping, 30 days of history, and an email within minutes when error volume jumps. Cloudflare's own tooling does none of the three.
2. **It costs nothing** at our volume, and running out costs nothing either — Sentry drops the excess and does not bill for it. There is no way for this to produce a surprise invoice.
3. **The code has no dependency on Sentry the company.** We speak the wire protocol directly, in about 300 lines we own. GlitchTip speaks the same protocol, so pointing at a GlitchTip we host ourselves is a change of one secret and no code at all. **You are choosing a supplier, not marrying one.**
4. **It is the only way to be certain about the customer data**, per §2. The official toolkit's defaults are the risk; hand-building the report removes it.

**A note on precedent, because it should not be buried.** The code in this repository records a previous decision against Sentry — `frontend/src/lib/errorReporter.ts` says "owner ruling: no Sentry", and the self-hosted reporter exists because of it. This PR does **not** overturn that ruling, and it does not need to: the reporter it adds is inert until a DSN is supplied, and the DSN is what decides whether the data goes to Sentry, to a GlitchTip in Frankfurt, or to a GlitchTip on our own server. If the original objection was to customer data leaving the building, §2 and §6 are the answer; if it was to Sentry the company specifically, §6 is. **The decision is yours and it is one line of configuration either way.**

---

## 5. Keeping it inside the free tier

Free plan: **5,000 errors per month**, which is about **167 a day**.

In normal operation the ERP is nowhere near that. The risk is a bad day: on 5 July, every single request failed for eighteen hours. Unthrottled, that would have spent a month's allowance before breakfast.

So the reporter has a brake built in:

- **Only genuine server failures are reported.** A 4xx — the ERP correctly telling a caller it got the request wrong — is never sent. That alone removes most of the volume.
- **Ten reports per minute maximum**, per server instance. Cloudflare runs several instances at once, so the real ceiling is a small multiple of that, but the order of magnitude holds.
- **Repeated identical errors are grouped by Sentry** into one issue with a counter, so a thousand copies is one line on the screen.
- **A sampling dial** (`SENTRY_SAMPLE_RATE`) exists if it is ever needed. It should not be.

**What happens when the quota does run out:** Sentry drops further events for the rest of the month and **does not bill for them**. Reporting resumes on the 1st. The alert that mattered will already have fired — an alert rule needs a handful of events, not thousands — so the practical cost of exhausting the quota is losing detail on an incident you have already been told about. Sentry also applies its own "spike protection" throttle on top of ours.

**The honest limit:** there is no setting that both alerts within a minute *and* survives eighteen hours of continuous failure inside 5,000 events. Nothing can do both. This is tuned to alert fast and accept the quota loss, which is the right way round.

---

## 6. If you would rather nothing left the building at all

Everything above still applies, with one change: instead of signing up at sentry.io, run **GlitchTip** — open source, MIT licensed — and use its address as the secret.

- **Requirements:** a Postgres 14+ database and roughly 512 MB of RAM. It is a Docker image.
- **Cost:** whatever the server costs. Nothing else.
- **Code changes needed:** **none.** Same protocol, same secret name, same command.
- **Trade-off, stated plainly:** it is another system to keep running, and a watchdog that dies alongside everything else is worth less than one hosted elsewhere. There is also a middle option — GlitchTip's own hosted service in Frankfurt, free for 1,000 errors a month or USD 15/month for 100,000, which keeps the data out of the United States without us running a server.

---

## 7. The one step you perform to switch it on

Nothing is active until this is done. There is no partial state.

### Backend — the only required step

```
cd backend
npx wrangler secret put SENTRY_DSN
```

It will prompt for the value; paste the DSN Sentry (or GlitchTip) gave you and press Enter. It takes effect immediately — **no deploy needed, no code change, no downtime.** The DSN looks like `https://<long-key>@o123456.ingest.us.sentry.io/7654321`.

### Frontend — nothing to do, by design

There is no second secret and no frontend key. Browser crashes already travel to our own server (the existing error boundary → `POST /api/client-errors`), and the server forwards them onward. Doing it this way means the DSN is never published in the public JavaScript bundle and the tracking service never sees a staff member's IP address. **One secret turns on both halves.**

(If direct browser-to-Sentry reporting is ever wanted — the only thing it would buy is capturing crashes on the login screen, before anyone is signed in — that would be a separate change, adding a `VITE_SENTRY_DSN` GitHub repository *variable* alongside the existing `VITE_API_URL` in `.github/workflows/deploy.yml`. Not recommended, for the IP-address reason above.)

### Then, inside Sentry, set up the alert — this is the part that pages someone

The code sends the errors; the alert rule is configured in Sentry's own screens and is what makes the difference between an archive and a warning:

1. **Alerts → Create Alert → Issues**
2. Condition: **"The issue is seen more than 20 times in one hour"**
3. Action: **email `hello@houzscentury.com`**
4. Add a second rule for **"A new issue is created"**, so a brand-new crash is seen the day it appears rather than after it becomes common.

Then, in **Settings → Security & Privacy**, switch on **"Prevent Storing of IP Addresses"** and **"Data Scrubber"**. Our code already withholds those, so this is a second lock on a door that is already shut — cheap, and it covers anything a future change forgets.

### To switch it off again

```
cd backend
npx wrangler secret delete SENTRY_DSN
```

Immediate, total, no deploy. The ERP returns to exactly its current behaviour.

---

## 8. The companion I recommend alongside it, also free

An error tracker only reports errors the ERP is alive enough to produce. It cannot report "the site is entirely unreachable" — the case where nothing runs.

Set up a **free external uptime check** that requests `https://erp.houzscentury.com/` every minute and emails when it fails twice in a row. **Better Stack** gives 10 monitors free and **UptimeRobot** has a long-standing free tier; either is fine. It is a web form, ten minutes, no code, and it is the direct answer to the COE's "nothing watches production between deploys". Sentry's free plan also includes one uptime monitor, so it can be done in the same account.

**Between the two — an error alert for "the ERP is failing" and an uptime alert for "the ERP is gone" — the 5 July outage would have been known about within minutes instead of after the fact.**

---

## 9. Sources

Checked 2026-07-22. Anything not confirmed at one of these is marked UNCONFIRMED in the text above.

- Sentry pricing and plan contents — `https://sentry.io/pricing/`
- Sentry data retention by plan — `https://docs.sentry.io/security-legal-pii/security/data-retention-periods/`
- Sentry data storage region, fixed at signup — `https://docs.sentry.io/organization/data-storage-location/`
- Sentry quota behaviour when exhausted — `https://docs.sentry.io/pricing/`
- Sentry data collected + `dataCollection` defaults — `https://docs.sentry.io/platforms/javascript/data-management/data-collected/` and `https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/options/`
- Sentry DSN is safe to publish — `https://docs.sentry.io/concepts/key-terms/dsn-explainer/`
- Cloudflare Workers Logs limits and retention — `https://developers.cloudflare.com/workers/observability/logs/workers-logs/`
- Cloudflare Workers pricing — `https://developers.cloudflare.com/workers/platform/pricing/`
- Cloudflare notification catalogue (contains no Workers error alert) — `https://developers.cloudflare.com/notifications/notification-available/`
- Cloudflare Tail Workers, Paid plan only — `https://developers.cloudflare.com/workers/observability/logs/tail-workers/`
- Cloudflare Analytics Engine pricing and limits — `https://developers.cloudflare.com/analytics/analytics-engine/pricing/`
- GlitchTip pricing — `https://glitchtip.com/pricing`; self-host requirements — `https://glitchtip.com/documentation/install`
- Better Stack pricing and regions — `https://betterstack.com/pricing`
- Highlight.io hosted service shutdown — `https://highlight.io/blog/launchdarkly-migration`
- Baselime acquisition and sunset — `https://blog.cloudflare.com/cloudflare-acquires-baselime-expands-observability-capabilities/`

### Two numbers to re-check before spending money

1. **Sentry's monthly (non-annual) Team price.** Sentry's own page shows the annualised **USD 26/month**; the **USD 29/month** figure for paying monthly comes from third-party pricing trackers, not from Sentry. Irrelevant while we stay free.
2. **Better Stack's free error-tracking allowance** (100,000 errors, unlimited seats). It appears in their machine-readable pricing under the free column but is presented ambiguously on the human page. Confirm inside the product before relying on it. It does not affect the recommendation.

---

## 10. Where the code is

| File | What it is |
|---|---|
| `backend/src/services/errorTracking.ts` | The whole reporter — about 300 lines, no external library. Inert without the secret |
| `backend/src/index.ts` (`app.onError`) | Backend failures. 5xx only |
| `backend/src/routes/clientErrors.ts` | Forwards browser crashes that the existing error boundary already captures |
| `backend/tests/errorTracking.test.ts` | Proves the inert path sends nothing and logs nothing, and asserts what the report does and does not contain |
| `backend/src/types.ts` | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_SAMPLE_RATE` |
| `frontend/src/components/RouteFallback.tsx` | The existing React error boundary — unchanged; it already feeds the path above |
| `frontend/src/lib/errorReporter.ts` | The existing browser reporter — unchanged behaviour |
