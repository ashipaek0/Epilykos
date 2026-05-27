# Epilykos — PVOutput Integration: Implementation Plan

**Status:** Ready for implementation  
**Spec reference:** `todo/epilykos-pvoutput-integration-spec.md`  
**Reviews:** 8 passes — 51 issues found, all resolved  
**Estimated effort:** 6–9 days (Phases 1–5)

---

## Spec Summary

Three integration directions:

| Direction | Flow | What it does |
|---|---|---|
| **PUSH** | Epilykos → PVOutput | Uploads live status every 5 min, end-of-day summary at 23:55 |
| **PULL** | PVOutput → Epilykos | Fetches history, stats, outputs — fills local gaps, powers dashboard charts |
| **ALERTS** | PVOutput → Epilykos webhook | Receives alert callbacks (high consumption, low generation, system idle, etc.) |

Rate limits: 60 req/hr free, 300 req/hr donation. A 5-min upload interval = 12 calls/hr, leaving ~48 for backfill and pulls.

---

## Review Findings & Design Resolutions

### Critical

#### C1. Timezone handling (absent in spec)

The mapper's `formatDate()` and `formatTime()` must render in the PVOutput system's *local* timezone, not UTC. If Epilykos sends timestamps in UTC and the system is in WAT (UTC+1), solar generation at 09:00 WAT appears as 09:00 UTC which is 10:00 local — PVOutput rejects boundary records with `"No sun"` and silently mislabels the rest.

**Resolution:** `mapper.js` uses `Intl.DateTimeFormat` with the system timezone:

```js
function formatStatusTimestamp(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    d: `${parts.year}${parts.month}${parts.day}`,
    t: `${parts.hour}:${parts.minute}`
  };
}
```

**Timezone source:** Fetched from `getsystem` response (includes system's registered timezone). Fallback chain: `pvoutput_config.timezone` → server local timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). The `timezone` field is added to `pvoutput_config` so users can set it manually before `getsystem` has been called.

#### C2. Batch uploads must not span midnight with `c1=1`

With `c1=1`, v1 is a daily cumulative that resets to 0 at midnight. If a single `addbatchstatus` call mixes records from day N and day N+1, PVOutput sees day N+1 records with v1 near 0 and rejects them with `"Energy value cannot be lower than previously recorded"` — invalidly comparing across date boundaries.

**Resolution:** **One `addbatchstatus` call per calendar date.** The backfill engine groups by date and never mixes dates in a single batch. Each date gets its own HTTP call. This is enforced in `backfill.js` as an invariant check before any batch is submitted.

### Significant

#### S3. End-of-day scheduler drift AND timezone gap (combined fix)

`setTimeout` calculated from startup time to reach 23:55 is unreliable over 24 hours (timer drift, system suspend). If restarted at 00:01, the next fire is 23:55 the *following* night, skipping today's EOD upload.

**Resolution:** Replace with a per-minute polling check that evaluates time in the PVOutput system timezone, not the server's local time:

```js
function getLocalTime(timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { h: parseInt(parts.hour), m: parseInt(parts.minute) };
}

setInterval(() => {
  const { h, m } = getLocalTime(config.timezone);
  // Note: _eodDoneToday shown for pattern clarity only.
  // Actual implementation derives state from pvoutput_daily_outputs per S7/NC3.
  // Do NOT implement as an in-memory boolean — use the DB query.
  if (h === 23 && m === 55 && !this._eodDoneToday) {
    this._eodDoneToday = true;
    this._eodUpload();
  }
  if (h === 0 && m === 1) {
    this._eodDoneToday = false;
  }
}, 60_000);
```

**Startup recovery — replace `_eodDoneToday` with DB check (C3 follow-on):** The in-memory flag resets to `false` on restart. If the server was down from 23:54 to 23:56, the 23:55 window is missed and the flag gives no indication the job never ran. Solution: on startup, after the polling loop initialises, query `pvoutput_daily_outputs` for today's date. If `status = 'uploaded'`, set `_eodDoneToday = true`. If not found and local time is past 23:55, trigger the EOD upload immediately. This eliminates the need for in-memory state entirely — the flag can be derived from the DB on each check.

The same timezone-aware `getLocalTime()` function is used for retry checks at 00:15 and 01:00. Both retries are evaluated in the PVOutput system timezone.

#### S4. `getstatistic` has its own rate limit pool

The general pool is 60/300 req/hr. `getstatistic` has a separate, smaller limit: 12/hr (free) / 60/hr (donation). A single `rateLimiter` token bucket won't know why a `getstatistic` call returned 429 and will pause *all* operations instead of just statistic fetches.

**Resolution:** `rateLimiter.js` tracks two buckets:

| Bucket | Free limit | Donation limit | Used by |
|---|---|---|---|
| `general` | 60/hr | 300/hr | addstatus, addoutput, addbatchstatus, getsystem, getoutput, getstatus, delete, webhook register |
| `statistic` | 12/hr | 60/hr | getstatistic only |

In practice `getstatistic` is called once daily so exhaustion won't occur, but on 429 the module must identify *which* pool is exhausted and only pause calls to that pool. This lets uploads continue even if statistic fetches are temporarily blocked.

#### S5. Webhook endpoint lacks request validation

PVOutput doesn't sign webhook payloads (no HMAC, no shared secret). Anyone discovering the URL can POST fake alerts. The endpoint is public by necessity.

**Resolution — two mitigations:**

1. **Rate-limit** the webhook endpoint at 10 req/min per IP using `express-rate-limit` (already in the project).
2. **Validate SID** — reject any request where `req.body.sid` doesn't match the configured `system_id`:

```js
if (String(req.body.sid) !== String(config.system_id)) {
  return res.status(403).send('Forbidden');
}
```

This won't stop a targeted attacker but eliminates casual abuse.

#### S6. `getsystem` timezone field is unverified

The timezone fallback chain is `pvoutput_config.timezone → getsystem response → server local`. But `getsystem`'s documented CSV fields (system name, size, postcode, panel/inverter details, orientation, tilt, install date, lat, lng, status interval) do not include a timezone. If it's absent, the middle step silently falls through to server local — which is UTC on a headless Debian server.

**Resolution:** Before Phase 1 code is written, verify whether `getsystem` returns a timezone identifier. If it does, document the field position. If not, derive timezone from the `latitude`/`longitude` fields in the `getsystem` response using `geo-tz` (zero-API-call npm package, ~50KB of IANA timezone boundary data). Fallback chain becomes: `config.timezone → getsystem (if present) → geo-tz(lat, lng) → server local with a warning log`. The user is never silently landed on UTC.

#### S7. `_eodDoneToday` not persisted across restarts

In-memory boolean resets to `false` on restart. If the server was down from 23:54 to 23:56, the 23:55 window never fires and the flag gives no indication the job never ran. The day's output is permanently missed.

**Resolution:** Covered in the S3 fix above — replace `_eodDoneToday` with a DB query against `pvoutput_daily_outputs` on startup. If today's output is not found and local time is past 23:55, trigger EOD upload immediately.

### Pre-existing Issues (first review missed)

#### P1. Gap detection threshold is fragile (50+ records) — **superseded by NS4**

~~Counting records per day produces false positives...~~

**Resolution superseded by NS4.** See NS4 for the current gap detection logic: local-tables-only query over `pvoutput_daily_outputs` + `pvoutput_upload_queue`. `pvoutput_history` is not used for gap detection.

#### P2. Rate limiter state not persisted across restarts

`this.remaining`, `this.limit`, and `this.resetAt` are in-memory. If Epilykos restarts at 23:59 having used 58 of 60 hourly calls, it restarts assuming 60 remaining — wastes 2 calls before hitting 429, and the upload at restart gets queued for backfill unnecessarily.

**Resolution:** Persist to config table under key `pvoutput_rate_limit_state` as a JSON blob: `{ general: { remaining, limit, resetAt }, statistic: { ... } }`. `updateFromHeaders()` writes to DB after updating in-memory state. On startup, if `resetAt` is in the past, ignore the persisted state (window has reset). One DB write per API call — acceptable at 12 calls/hr.

### Third Review — New & Remaining Issues

#### NC1. "No new npm dependencies" contradicts `geo-tz` (S6 follow-on)

The S6 resolution introduced `geo-tz` as a dependency, but the Module Architecture section stated "No new npm dependencies." These are mutually exclusive.

**Resolution:** Removed the contradictory claim. Module Architecture now states: *"Dependencies: `node-fetch` (existing), `geo-tz` (new — IANA timezone lookup from lat/lng, ~50KB, zero API calls). No other new packages."* `geo-tz` will be added to `package.json` as part of Phase 1.

#### NC2. EOD data source is ambiguous; peak power unspecified

Phase 2 states the EOD job "reads day's max daily_solar from `history` table" but doesn't name the actual table in Epilykos's schema. The `addoutput` payload also requires `pp` (peak power in W) and `pt` (peak time `hh:mm`) for the day — neither of which is tracked anywhere in the current plan.

**Resolution:** The source is the Epilykos `history` table (the existing SQLite table with `timestamp`, `solar`, `consumption`, etc.). For EOD:

- **`g` (energy generated, Wh):** `SELECT MAX(daily_solar) FROM history WHERE date(timestamp, 'unixepoch') = today` — the running daily cumulative max equals the day's total. Convert kWh → Wh (×1000).
- **`pp` (peak power, W):** `SELECT MAX(solar) FROM history WHERE date(timestamp, 'unixepoch') = today` — the instantaneous `solar` column max.
- **`pt` (peak time, `hh:mm`):** `SELECT datetime(timestamp, 'unixepoch') FROM history WHERE date(timestamp, 'unixepoch') = today ORDER BY solar DESC LIMIT 1` — extract the `HH:MM` portion in local timezone.
- **`c` (consumption, Wh):** `SELECT MAX(daily_consumption) FROM history WHERE date(timestamp, 'unixepoch') = today` × 1000.

All four values come from the existing `history` table. No new schema or in-memory tracking needed.

#### NC3. `_eodRetryCount` still in-memory despite S7 fix

S7 replaced `_eodDoneToday` with a DB check, but Phase 2 still references `_eodRetryCount` as the retry gate. This has the same persistence problem — it resets to zero on restart, making the retry state unreliable.

**Resolution:** Add an `attempts INTEGER DEFAULT 0` column to `pvoutput_daily_outputs`. When the EOD upload fires, increment `attempts` in the DB row. When it succeeds, set `status = 'uploaded'` and stop retrying. On startup, the polling check queries `pvoutput_daily_outputs` for today's date: if `status != 'uploaded'` and `attempts < 3`, and the local time matches the next retry slot (00:15 for attempt 1, 01:00 for attempt 2), fire the retry. No in-memory counters. The S7 DB check replaces both `_eodDoneToday` and `_eodRetryCount`.

#### NS4. Gap detection cross-reference logic is self-contradicted (P1 follow-on)

The P1 resolution cross-references `pvoutput_upload_queue.uploaded` against `pvoutput_history`. But `pvoutput_history` is populated only by the pull path — it's empty on first run or when Phase 3 isn't yet deployed. An empty `pvoutput_history` on a 30-day-old installation would flag all 30 dates as gaps, triggering 30 `getstatus` calls and exhausting the free rate limit budget.

The actual intent of gap detection is: "find dates where Epilykos was active but failed to upload to PVOutput." That's detectable from local tables alone.

**Resolution:** Redefine gap detection as a query over **local Epilykos tables only**:

- Query `pvoutput_daily_outputs` for dates with `status != 'uploaded'` in the lookback window (filtered `source = 'push'` per GC1).
- Query `pvoutput_upload_queue` for dates with entries in `failed` or `expired` status.
- The union of these date sets is the gap list — feeds `backfill.js` for re-upload.
- ~~Fetch those dates from PVOutput via `getstatus`.~~ **Partially superseded by FC2:** `getstatus` is not called from the gap detection path. Gap detection feeds backfill.js only. See FC2.
- `pvoutput_history` remains a cache of pulled data for dashboard use — it is **not** part of gap detection logic.

#### NS5. Free-account backfill cannot use `addbatchstatus` — rate impact unaddressed

`addbatchstatus` requires donation mode (spec section 4). Free accounts must fall back to individual `addstatus` calls. The rate impact: 14 days × ~96 records/day ≈ 1,344 records. At 48 available calls/hr (12 reserved for live uploads), that's 28 hours of continuous backfill. The plan doesn't branch on account type.

**Resolution:** `backfill.js` checks `isDonationAccount()`:

- **Donation:** Use `addbatchstatus.jsp`, one call per date (C2), batch size 100, 10s delay between calls.
- **Free:** Use individual `addstatus.jsp` calls. ~~75-second inter-call delay (3600/48 ≈ 75s).~~ **Rate control superseded by FS4:** the inter-call delay is a courtesy pause (10s); `rateLimiter.canCall()` is the sole rate gate. See Phase 2 backfill.js checklist for the correct implementation.

Settings UI: if the pending queue has >100 records and donation mode is not active, show a warning: *"Large backfill queue detected (N records). With a free account this may take ~X hours. Consider enabling donation mode for batch upload support."* The "Run Backfill" button displays an estimated completion time.

#### NM6. Timezone field is mandatory before first `getsystem` call (S6 follow-on)

The `geo-tz` fallback requires lat/lng from `getsystem`, which hasn't been called before the user presses "Test Connection." Until then, the fallback lands on server local time — UTC on most servers — producing the C1 timezone bug.

**Resolution:** Settings UI marks the timezone field as required. It is pre-populated with `Intl.DateTimeFormat().resolvedOptions().timeZone` (server local). A warning is shown if the field is empty on save: *"Timezone must be set. Press Test Connection to auto-detect, or enter it manually."* The Test Connection button, on success, auto-fills the timezone from the `getsystem` response (if present) or from `geo-tz(lat, lng)`.

#### NM7. Single-date batch can exceed batch size limit (C2 follow-on)

C2 enforces one batch call per calendar date. But a free account with 288 records for a single missed day overflows the 30-record batch limit.

**Resolution:** Add inner chunking within a single date. For each date, split its records into chunks of `batchSize`, submit each chunk sequentially with a 10s courtesy pause (rate controlled by `canCall()` per FS4 — if denied, sleep until `msUntilReset()` and retry). The C2 invariant (no cross-date mixing) remains intact.

### Fourth Review — New & Remaining Issues

#### FC1. Peak time (`pt`) extracted in UTC, not local timezone (NC2 follow-on)

NC2 specifies `datetime(timestamp, 'unixepoch')` for `pt`, then says "HH:MM extracted in local timezone." SQLite's `datetime()` always returns UTC. If implemented naively, Lagos (WAT, UTC+1) peak times are submitted one hour off — potentially before sunrise.

**Resolution:** The query returns the raw Unix integer timestamp of the peak row. The JavaScript layer converts it to `HH:MM` using the existing `formatStatusTimestamp(new Date(ts * 1000), config.timezone)` function from `mapper.js` (C1). Never let SQLite format the time. Phase 2 checklist updated to state this explicitly.

#### FC2. Gap detection conflates push-failure recovery with pull operation (NS4 follow-on)

After NS4, gap detection queries local tables for failure states, then says "Fetch those dates from PVOutput via `getstatus`." This is wrong — if Epilykos failed to push data to PVOutput, PVOutput doesn't have it either. The correct response is to retry uploading (backfill.js), not to download.

The `getstatus` pull and the backfill push are two **completely separate operations**:

- **Upload gap recovery:** dates where Epilykos failed to push → handled by `backfill.js` (already correct). Nothing to fetch from PVOutput.
- **Dashboard history population:** fetch recent status history from PVOutput to populate `pvoutput_history` for chart views → driven by Phase 3's *scheduled pull*, independent of any gap list.

**Resolution:** Remove `getstatus` from the gap detection path entirely. The gap detection output feeds `backfill.js` only. Phase 3's `getstatus` scheduled fetch operates on a fixed lookback window (last 7 days at startup), orthogonal to gap detection. Clarify the separation in both Phase 2 and Phase 3 checklist items.

### Significant (fourth review)

#### FS3. `history` table column names and timestamp format are unverified (NC2 exposed)

NC2 queries `MAX(daily_solar)`, `MAX(solar)`, `MAX(daily_consumption)` with `date(timestamp, 'unixepoch')`. Both column names and the timestamp format are assumed. If timestamp is stored as ISO 8601 strings instead of Unix integers, `'unixepoch'` silently returns NULL for every row — producing NULL for all four EOD values, causing `addoutput` to fail with 400 or upload zeroes. This fails silently.

**Resolution:** Add an explicit pre-condition to the Phase 2 checklist: *"Verify `history` table schema: confirm column names (`solar`, `daily_solar`, `daily_consumption`) exist and `timestamp` is stored as `INTEGER` Unix epoch seconds. If timestamp is `TEXT` ISO 8601, use `date(timestamp)` without the `'unixepoch'` modifier, and extract the Unix timestamp differently for `pt` calculation."*

#### FS4. Free-account backfill delay arithmetic misrepresented as rate control (NS5 follow-on)

NS5 frames the 75-second inter-call delay as the rate control mechanism. But the backfill loop and the live upload timer run concurrently — both can call `canCall()` at the same instant, both may get `true`, and the combined rate can momentarily exceed 60/hr. If the timer is later adjusted or someone changes the live upload interval, the arithmetic breaks silently.

**Resolution:** Reframe the backfill behaviour: the inter-call delay is a **courtesy pause to avoid bursting**, not the rate control mechanism. The `rateLimiter.canCall('general', 'low')` is the sole gate — if it returns false, backfill sleeps until `msUntilReset()` and retries. Replace the 75s calculation with: *"backfill calls `canCall()` before each request; if denied, waits until the window resets. A 10-second minimum pause between successful calls prevents bursting when the pool has headroom."*

### Minor (fourth review + pre-existing)

#### FM5. `attempts` retry slot mapping is ambiguously specified (NC3 follow-on)

NC3 says "the local time matches the next retry slot (00:15 for attempt 1, 01:00 for attempt 2)" but doesn't define the mapping between `attempts` value and target time. A developer could implement "if attempts < 3 and time is 00:15, fire" — which triggers regardless of whether the initial 23:55 attempt ran.

**Resolution:** Add an explicit lookup table to the Phase 2 checklist:

| `attempts` | Meaning | Fire at (local time) |
|---|---|---|
| 0 | Not yet attempted | 23:55 |
| 1 | First attempt failed | 00:15 |
| 2 | Second attempt failed | 01:00 |
| 3 | All attempts failed | Set `status = 'failed'`, stop |

Each polling tick checks: `if (attempts === 0 && h === 23 && m === 55) fire(); else if (attempts === 1 && h === 0 && m === 15) fire(); else if (attempts === 2 && h === 1 && m === 0) fire();`

#### FM6. Duplicate settings UI checklist in Phase 2 (NS5 edit merge artefact)

Phase 2 has two consecutive settings UI bullet points — the old one and the NS5-updated one — with conflicting detail ("pending count" vs "pending count per date").

**Resolution:** Remove the stale duplicate. The NS5-updated version is authoritative.

#### FM7. `pvoutput_history` has no defined dashboard consumer after NS4

After NS4 removed `pvoutput_history` from gap detection, its only remaining purpose is "pull cache for dashboard use" — but no dashboard component is mapped to it. Phase 3 references "lifetime stats card and monthly comparison chart" which draw from `pvoutput_stats_cache` and `pvoutput_daily_outputs`. If no panel reads `pvoutput_history`, it's dead infrastructure.

**Resolution:** Either define a consumer or remove the table. Simplest path: Phase 3's scheduled `getstatus` fetch populates `pvoutput_history` on a 7-day rolling window, and a new dashboard panel "Intraday History" renders a past-date power curve from `pvoutput_history`. This gives the table a clear purpose. If the intraday panel is deferred to a later release, flag `pvoutput_history` as "created but dashboard consumer not yet built" so it isn't dead code.

### Seventh Review — Cleanup Issues

#### RC1. `startPvoutput(db, app)` signature doubly vestigial after HC1 + GM7

HC1 moved routes into server.js. GM7 established `db`/`logger` are imported internally. Both parameters are vestigial, yet the server.js integration block and Phase 1 checklist still pass wrong signatures. After HC1+GM7: the module contract is `start()` / `stop()` / `restart()` with no arguments.

**Resolution:** Server.js block, Phase 1 checklist, and GM7 resolution text all updated to the zero-argument signature. `startPvoutput()` and `restartPvoutput()` take no arguments.

#### RC2. `pvoutputWebhookRouter` and `pvoutputRouter` referenced but never imported (HC1 follow-on)

The server.js block registers routes using `pvoutputWebhookRouter` and `pvoutputRouter` but neither is imported. This is a `ReferenceError` at startup.

**Resolution:** Server.js integration block now includes:
```js
const pvoutput = require('./modules/pvoutput');
const { router: pvoutputWebhookRouter } = require('./modules/pvoutput/webhook');
// pvoutput.router is exported from pvoutput.js — no separate routes file needed
```

#### RM3. NS5 resolution still says "75-seconds"; FS4 supersedes without annotation

Same pattern as P1→NS4→FC2. NS5's 75s arithmetic struck through and marked "Rate control superseded by FS4."

#### RM4. HM5 INSERT only covers past-23:55; normal first-day 23:55 tick finds no row

HM5 covers the startup-recovery path but not the normal polling tick. If Epilykos starts at noon with no row for today, `attempts` query returns `null` at 23:55, `null === 0` is false, EOD upload silently skipped.

**Resolution:** Phase 2 startup recovery now requires `INSERT OR IGNORE` on **every** startup, not only the past-23:55 branch. `INSERT OR IGNORE` preserves existing rows; creates the row if absent.

#### RM5. Monthly chart pull-only dates (pre-installation) behaviour undefined

Phase 3 says the chart filters on `source = 'push'` with pull rows as "supplementary." For pre-installation dates, only pull rows exist — chart behaviour is unspecified.

**Resolution:** Chart query: `source = 'push'` rows with fallback to `source = 'pull'` for dates where no push row exists. Pre-installation dates show PVOutput data; active dates show Epilykos data.

### Sixth Review — Final Issues

#### HC1. Routes double-registered on every `restartPvoutput()` call (GM7 follow-on)

The GM7 resolution moved route registration inside `startPvoutput()`. `restartPvoutput(db, app)` is called on every config save. Express `app.use()` is additive — calling it twice appends a second handler, not replacing the first. After config saves, multiple handler copies exist; requests hit the first one (stale config), making restarts invisible to active requests.

**Resolution:** Separate routes from engine lifecycle — same pattern every other Epilykos module uses. Routes registered once in `server.js` before `startPvoutput()`. `restart()` stops/restarts only the `setInterval` scheduling engines (`push.js`, `pull.js`, `backfill.js`) and reloads config from DB. Routes are never touched by restart. Updated in the `server.js` Integration block.

#### HS2. NS4 resolution text still instructs fetching from PVOutput via `getstatus` (same failure mode as GM5/P1)

NS4's resolution block still says "Fetch those dates from PVOutput via `getstatus`." FC2 removed `getstatus` from gap detection, but a developer reading findings in order hits NS4 first and implements the `getstatus` fetch before reaching FC2's correction — same failure mode GM5 caught with P1 in the previous round.

**Resolution:** NS4's last bullet now struck through and marked "Partially superseded by FC2." Same treatment as P1 → NS4.

#### HS3. `pvoutput_daily_outputs` INSERT behaviour for pull rows on existing push dates unspecified (GC1 follow-on)

`date` is the PRIMARY KEY. Phase 3's `getoutput` writes rows with `source = 'pull'` for dates that already have a `source = 'push'` row from EOD. Three SQL variants → three outcomes:

- `INSERT OR IGNORE` — silently skips, push row preserved (correct).
- `INSERT OR REPLACE` — deletes push row, destroying `status`/`attempts`/`source` (silent data loss).
- Plain `INSERT` — UNIQUE constraint violation (crash).

**Resolution:** Phase 3 `getoutput` checklist now explicitly states `INSERT OR IGNORE`. `INSERT OR REPLACE` is forbidden. Pull data for dates with existing push rows is not separately stored; the push row is authoritative for those dates.

#### HM4. S3 code snippet still shows `_eodDoneToday` in-memory flag

S3 resolution block contains a `setInterval` snippet with `!this._eodDoneToday` and `this._eodDoneToday = true`. S7 and NC3 replace this with a DB query, but the code snippet doesn't state that. A developer copying it directly implements the in-memory flag.

**Resolution:** Snippet annotated: *"Note: `_eodDoneToday` shown for pattern clarity only. Actual implementation derives state from `pvoutput_daily_outputs` per S7/NC3. Do NOT implement as an in-memory boolean."*

#### HM5. Startup EOD recovery fires before today's DB row exists

Phase 2 says: "If not found and local time is past 23:55, trigger EOD upload immediately." If no row exists, `UPDATE` to increment `attempts` is a no-op. On next restart, the same path fires again — no persistence.

**Resolution:** Phase 2 checklist now states: INSERT the row first (`status = 'pending', attempts = 0, source = 'push'`), then fire the upload.

### Fifth Review — Remaining Issues

#### GC1. `pvoutput_daily_outputs` has two writers with incompatible semantics (FC2 + NS4 follow-on)

Phase 2 (push) writes rows to track EOD upload state. Phase 3 (pull) also writes to the same table via `getoutput` — "populates for last 30 days if not already present." The "if not present" guard prevents overwriting push rows, but pull-fetched rows for pre-installation dates get `status='pending'` and `attempts=0` (defaults). Phase 3 gap detection reads `status != 'uploaded'` and flags every pull-fetched row as a gap, triggering pointless backfill of data Epilykos never owned.

**Resolution:** Add a `source TEXT NOT NULL DEFAULT 'push'` column to `pvoutput_daily_outputs`. Values: `push` for EOD upload tracking, `pull` for `getoutput` cache rows. Gap detection queries filter on `source = 'push'` only. Pull-fetched rows are excluded from gap detection entirely. Database schema updated to reflect this.

#### GS2. Error handling table lists 02:00 retry; FM5 lookup stops at 01:00

The error handling table has *"Retry at 00:15, 01:00, 02:00"* but the FM5 lookup table defines only two retry slots (00:15 for attempt 1, 01:00 for attempt 2). FM5 is authoritative.

**Resolution:** Remove `02:00` from the error handling table row. Correct text: *"Retry at 00:15 and 01:00 via polling loop (S3/FM5), then set `status = 'failed'` after 3 attempts."*

#### GS3. `getstatus` startup fetch runs every restart, wasting rate budget

Phase 3 fetches "last 7 days" on every startup. On a free account, 7 calls per restart exhausts the 60/hr budget during development. Should be cache-aware.

**Resolution:** Gate each `getstatus` call: query `pvoutput_history` for whether the target date already has rows. Skip the call if so. On first startup (empty table), fetch all 7 days. On subsequent restarts (table populated), typically zero calls.

#### GS4. Gap detection → backfill.js coordination mechanism unspecified

Phase 3 lists gap detection under `pull.js` but says its output "feeds `backfill.js`." The handoff mechanism is never defined — is it an event, a shared table, or does backfill.js run the query itself? Two different implementers will produce two different architectures.

**Resolution:** Move gap detection into `backfill.js`. It already reads `pvoutput_upload_queue` and `pvoutput_daily_outputs` — it can run the local-tables query internally on startup and when "Run Backfill" is triggered. Remove gap detection from Phase 3 checklist entirely. `pull.js` handles scheduled read operations only, with zero awareness of backfill state.

#### GM5. P1 resolution text contradicts NS4 in the same document — fixed above

P1 now marked "superseded by NS4" with a forward reference and the stale text struck through.

#### GM6. `pvoutput_upload_queue` missing index on `date`

Schema lists only an index on `status`. Gap detection and backfill group by date. With a large queue, full table scans on every startup gap check.

**Resolution:** Add `CREATE INDEX IF NOT EXISTS idx_pvoutput_queue_date ON pvoutput_upload_queue(date)`. Or a composite `(date, status)` index that serves both date-grouping and status-filter queries.

#### GM7. `startPvoutput()` signature mismatch with module contract

The `server.js` integration calls `startPvoutput()` with no arguments. The `pvoutput.js` module contract is `start(db, logger, app)`. One of them is wrong.

**Resolution:** `modules/pvoutput.js` imports `getDb` from `database.js` and `logger` from `logger.js` directly — same pattern as every other Epilykos module. The `app` parameter is no longer needed (routes registered in `server.js` per HC1). The module contract is `start()` / `stop()` / `restart()` with no arguments. Updated in server.js integration block and Phase 1 checklist.

### Minor (new + pre-existing)

#### M6. `pvoutput_daily_outputs.uploaded` type mismatch

Schema defines `uploaded INTEGER DEFAULT 0` but the error handling references `upload_failed` as a distinct state. Two approaches: change to `status TEXT DEFAULT 'pending'` or add a separate `failed_at` column.

**Resolution:** Use `status TEXT DEFAULT 'pending'` with values `pending | uploaded | failed | expired`. Matches `pvoutput_upload_queue.status` and is self-documenting.

#### M7. `pvoutput_stats` singleton row → settings table

A table with `CHECK (id = 1)` is inconsistent with the rest of Epilykos.

**Resolution:** Store stats in the existing `config` settings table under key `pvoutput_stats_cache` as a JSON blob with a `fetched_at` field. No new table. Same pattern as `pvoutput_config` itself.

#### M8. `getsystem` shared path between Phase 1 and 3

Phase 1's test button calls `getsystem` to validate credentials. Phase 3 adds a scheduled startup fetch that caches the result. These must share the same underlying logic.

**Resolution:** A single `fetchSystemInfo()` function in `pull.js` handles both paths. It always parses the CSV response and returns `{ name, size, timezone, ... }`. Phase 1 calls it on demand without writing to cache. Phase 3 wraps it with `cacheSystemInfo()` that upserts into `pvoutput_system`. The test endpoint and the startup scheduler call the same function — no code duplication.

#### M9. Donation mode UI — checkbox vs auto-detection contradiction

A checkbox says "user sets it"; auto-detection says "Epilykos sets it." Both have value: auto-detection is convenient but a user might have donated since the last check.

**Resolution:** Read-only indicator, not a checkbox. Show `Donation mode: Yes ✓` or `No` updated whenever any API response is received (all responses include rate limit headers from which the limit is derived). Include a "Re-detect" button next to it for manual refresh. `rateLimiter.isDonationAccount()` reads `this.limit >= 300`.

#### M10. Extended data prerequisite not documented

Extended channels v7–v12 must be configured in the user's PVOutput account *before* Epilykos uploads data to them. Without this, uploads succeed but data never appears on the graph — confusing users who mapped metrics and see nothing.

**Resolution:** Settings UI for extended data includes a note: *"Configure these channels in your PVOutput account under System → Extended Data before mapping here. Each channel needs a label, unit, and colour assigned in PVOutput first."*

#### M11. PVOutput 5-minute rounding affects backfill audit trail

The API rounds `t` to 5-minute intervals. A failed upload queued at 10:03 and retried via backfill rounds to 10:05 — same slot as a successfully-uploaded 10:05 record. PVOutput returns `"OK 200: Updated Status"` instead of an error. This is correct behaviour, but the backfill engine should log the response text distinctly so audits aren't confused.

**Resolution:** The backfill response handler checks for `"Updated Status"` vs `"Added Status"` in the response body and logs accordingly. Queue entries are marked `uploaded` in both cases but the log distinguishes them.

#### M12. First upload fires before metrics store is populated

If Epilykos starts at exactly :00, :05, or :10, the 5-minute boundary alignment delay calculates to 0ms and the first `addstatus` fires immediately — before Home Assistant, MQTT, or dongle modules have completed their first polling cycle. The first status record contains stale or zero values.

**Resolution:** Enforce a minimum 30-second delay before the first upload: `Math.max(msToNextBoundary, 30_000)`. This gives all poll-based sources time to populate `latest_metrics`.

---

### Spec Corrections (from first review)

These were in the original plan and remain valid:

1. **Metrics Store Access** — Use `getCurrentMetrics()` from `modules/metrics.js`, not a non-existent `metricsStore.getAll()`.
2. **Request Encoding** — POST bodies must be `application/x-www-form-urlencoded`, not JSON. The client form-encodes all `addstatus`, `addoutput`, `addbatchstatus` payloads.
3. **Config Key Naming** — Use nested `metric_map` object in config JSON (e.g. `metric_map.v1`) for clean separation from operational settings.
4. **`system_size_w` Fallback** — Validation falls back to user-configured value if `getsystem` hasn't been cached yet. Skip check entirely if neither exists.
5. **HTTP Library** — Use `node-fetch` (already in server.js), no new dependency.
6. **Webhook Optional** — Registration skipped if `webhook_url` is empty. Most LAN users won't have a public URL.

---

## Module Architecture

```
modules/
├── pvoutput.js                  # Main: start/stop/restart, exports router for protected API routes (SC1)
└── pvoutput/
    ├── client.js                # HTTP client: auth headers, form encoding, rate limit parsing
    ├── push.js                  # Upload scheduler: addstatus (5-min), addoutput (23:55)
    ├── pull.js                  # Data fetcher: getsystem, getstatistic, getoutput, getstatus
    ├── backfill.js              # Gap detection, batch upload from queue
    ├── webhook.js               # Express router: POST /api/pvoutput/webhook
    ├── mapper.js                # Epilykos metrics → PVOutput parameters
    └── rateLimiter.js           # Token bucket: priority levels, persistent state
```

**Dependencies:** `node-fetch` (existing), `geo-tz` (new — IANA timezone lookup from lat/lng, ~50KB, zero API calls). No other new packages.

---

## Implementation Phases

### Phase 1 — Push: Live Status Upload (2–3 days)

Core upload loop. Gets data flowing to PVOutput every 5 minutes.

**Critical design constraints applied:** C1 (timezone mapper), C2 (batch midnight — enforced in Phase 2 but mapper is written aware of it).

**Files to create:**
- [ ] `modules/pvoutput/client.js` — `POST`/`GET` wrappers with `X-Pvoutput-Apikey`/`X-Pvoutput-SystemId` headers, form-encoding for POST bodies, rate limit header extraction from responses. Handles 401 (invalid key), 429 (rate limited), 400 (validation errors).
- [ ] `modules/pvoutput/rateLimiter.js` — Two token buckets: `general` (60/300) and `statistic` (12/60). `canCall(pool, priority)`, `updateFromHeaders(pool, headers)`, `msUntilReset(pool)`, `isDonationAccount()`. **Persists state to `pvoutput_rate_limit_state` config key on update; restores on startup, ignoring if `resetAt` is in the past (P2).** See S4.
- [ ] `modules/pvoutput/mapper.js` — `buildStatusPayload(metrics, config)` returns form params with local-timezone date/time via `Intl.DateTimeFormat` (C1), `deriveBatteryState(soc, power)`, `validatePayload(payload, systemSizeW)`. **Timezone from config → `getsystem` cache → `geo-tz(lat, lng)` → server local with warning (S6).**
- [ ] `modules/pvoutput/push.js` — `PVOutputPushEngine` class: aligns to 5-min boundary with **30s minimum startup delay (M12)**, calls `addstatus.jsp`, queues failures to `pvoutput_upload_queue`. EOD scheduler uses timezone-aware per-minute polling (S3/S7).
- [ ] `modules/pvoutput.js` — main `start()` / `stop()` / `restart()`. Imports `getDb` and `logger` internally per GM7. Routes are registered by server.js per HC1. Reads `pvoutput_config`.
- [ ] Database: `pvoutput_upload_queue` table, `pvoutput_daily_outputs` table (with `status TEXT` per M6), `pvoutput_config` and `pvoutput_rate_limit_state` keys in essentials. Rate limit state key persisted by `rateLimiter.js`.
- [ ] `server.js` — import, start on boot, restart on config save
- [ ] Settings UI — credentials (API key, system ID), **timezone field (required — pre-populated with server local, warning if empty per NM6)**, read-only donation mode indicator + Re-detect button (M9), test button (on success auto-fills timezone from `getsystem` or `geo-tz`), basic metric mapping dropdowns
- [ ] `package.json` — add `geo-tz` dependency
- [ ] API: `GET /api/pvoutput/status`, `POST /api/pvoutput/test` (calls `fetchSystemInfo()` shared with Phase 3 per M8)

**Validation:** Every 5 minutes a status line appears on pvoutput.org with correct power/energy values in the correct local timezone.

### Phase 2 — End of Day + Backfill (1–2 days)

Daily summaries and recovery from downtime.

**Pre-condition (FS3):** Before writing EOD queries, verify the actual Epilykos `history` table schema — confirm column names (`solar`, `daily_solar`, `daily_consumption`) and timestamp storage format (`INTEGER` Unix epoch vs `TEXT` ISO 8601). Adjust query modifiers accordingly.

- [ ] `modules/pvoutput/push.js` — EOD upload at 23:55 in PVOutput system timezone via per-minute polling (S3/S7). **EOD data source (NC2):** all from the existing Epilykos `history` table:
  - `g` (energy Wh) = `MAX(daily_solar)` for today × 1000 (kWh→Wh)
  - `pp` (peak power W) = `MAX(solar)` for today
  - `pt` (peak time) = raw Unix timestamp of the row with `MAX(solar)`, converted to `HH:MM` via `formatStatusTimestamp(new Date(ts * 1000), config.timezone)` — the same timezone-aware mapper function from C1. **Never** format in SQLite (FC1).
  - `c` (consumption Wh) = `MAX(daily_consumption)` for today × 1000
- [ ] **Startup recovery (NC3 + FM5 + RM4):** On **every** startup, regardless of current time, ensure today's push row exists: `INSERT OR IGNORE INTO pvoutput_daily_outputs (date, status, attempts, source) VALUES (?, 'pending', 0, 'push')`. This covers both paths — the past-23:55 recovery (HM5) and the normal first-day 23:55 tick (RM4). Without it, if no row exists when the polling tick fires at 23:55, `attempts` queries return `null`, `null === 0` is `false`, and the EOD upload is silently skipped. `INSERT OR IGNORE` preserves any existing row. Polling tick evaluates `attempts` against the lookup table:

  | `attempts` | Meaning | Fire at (system local) |
  |---|---|---|
  | 0 | Not yet attempted | 23:55 |
  | 1 | First attempt failed | 00:15 |
  | 2 | Second attempt failed | 01:00 |
  | 3 | All attempts failed | Set `status = 'failed'`, stop |

  Implementation: `if (attempts === 0 && h === 23 && m === 55) fire(); else if (attempts === 1 && h === 0 && m === 15) fire(); else if (attempts === 2 && h === 1 && m === 0) fire();` — exact slot match, not a range check. Increments `attempts` in DB before each attempt. Sets `status = 'uploaded'` on success. No in-memory counters.
- [ ] `modules/pvoutput/backfill.js` — reads `pvoutput_upload_queue`, groups pending by date. **Gap detection lives here (GS4):** on startup and when "Run Backfill" is triggered, runs the local-tables query over `pvoutput_daily_outputs` (filtered `source = 'push'` per GC1) and `pvoutput_upload_queue`. No coordination with `pull.js` needed — backfill.js owns both the detection and the recovery. **Branches on account type (NS5):** donation uses `addbatchstatus.jsp` (100/batch); free uses individual `addstatus.jsp`. **Rate control (FS4):** the inter-call delay is a courtesy pause (10s) to avoid bursting. The `rateLimiter.canCall('general', 'low')` is the sole gate — if it returns false, backfill sleeps until `msUntilReset()` and retries. **Invariant: one date per batch call** — never mixes dates (C2). **Inner chunking within dates (NM7):** splits records into batch-size chunks even within a single date. Marks entries `uploaded` or `failed`. Discards entries older than lookback window as `expired`. **Logs `"Updated Status"` vs `"Added Status"` distinctly (M11).**
- [ ] Database: `pvoutput_daily_outputs` table — add `attempts INTEGER DEFAULT 0` column (NC3).
- [ ] Settings UI — queue panel showing pending count, estimated completion time, free-account warning if queue > 100 records and not donation (NS5). "Run Backfill" button, last upload timestamp.
- [ ] API: `GET /api/pvoutput/queue`, `POST /api/pvoutput/backfill`

### Phase 3 — Pull + History (1–2 days)

Fetch data back from PVOutput for dashboard panels. **Separate from backfill (FC2):** pull.js retrieves data PVOutput already has, for display purposes only. It does not participate in gap detection or push-failure recovery — those belong to backfill.js.

- [ ] `modules/pvoutput/pull.js` — scheduled fetches. **All scheduled times evaluated via `getLocalTime(config.timezone)` (same as push.js per S3/S6) — never use `new Date().getHours()` directly or UTC drift will cause pulls to fire at wrong local times.**
  - `fetchSystemInfo()` on startup — calls `getsystem.jsp` (shared with Phase 1 test endpoint per M8). Caches result to `pvoutput_system` table. **Extracts timezone from getsystem response (if present) or derives from lat/lng via `geo-tz` (S6).**
  - `getstatistic` daily at 01:00 — uses `statistic` rate limit pool (S4). Result cached as JSON in `config` table under key `pvoutput_stats_cache` (M7).
  - `getoutput` daily at 01:30 — populates `pvoutput_daily_outputs` for last 30 days. **Uses `INSERT OR IGNORE` (HS3):** for dates that already have a `source = 'push'` row from EOD, the pull row is silently skipped — the push row is authoritative. `INSERT OR REPLACE` is forbidden (it would destroy `status`, `attempts`, and `source` tracking). If pull data for a date with an existing push row needs to be stored, use a separate query path — but the monthly chart reads from the push row directly.
  - `getstatus` on startup — fetches status history for the last 7 days into `pvoutput_history`. **Cache-gated (GS3):** before each call, check whether `pvoutput_history` already has rows for the target date. Skip the call if so. On first startup (empty table) all 7 dates are fetched; on subsequent restarts, zero calls typically.
- [ ] Database: `pvoutput_history`, `pvoutput_system` tables. Stats stored in config table (not a separate table).
  - `pvoutput_history` columns: `date TEXT NOT NULL, time TEXT NOT NULL, energy_gen INTEGER, power_gen INTEGER, energy_con INTEGER, power_con INTEGER, efficiency REAL, temperature REAL, voltage REAL, UNIQUE(date, time)`.
  - Index: `CREATE INDEX IF NOT EXISTS idx_pvoutput_history_date ON pvoutput_history(date)`.
- [ ] Dashboard: **`pvoutput_history` consumer (FM7):** a new "Intraday History" panel renders a past-date power curve from `pvoutput_history` — selectable date, shows the bell curve of solar generation for that day. This gives `pvoutput_history` a clear purpose. If deferred, flag the table as "created but dashboard panel pending."
- [ ] Dashboard: lifetime stats card (`pvoutput_stats_cache`) and monthly comparison chart (`pvoutput_daily_outputs`).
  - `pvoutput_daily_outputs` schema includes `source TEXT NOT NULL DEFAULT 'push'` (GC1). Monthly chart query: `SELECT * FROM pvoutput_daily_outputs ORDER BY date` (SM3). Because `INSERT OR IGNORE` (HS3) ensures each `date` PK has at most one row, and push rows are created before any pull fetch for the same date, every row is already the highest-priority data for its date by construction. Pre-installation dates have only pull rows; active dates have push rows. No explicit fallback query is needed.
- [ ] API: `GET /api/pvoutput/history?d=yyyymmdd`, `GET /api/pvoutput/stats`
- [ ] API: `POST /api/pvoutput/delete` (admin tool for data correction)

### Phase 4 — Webhook + Alerts (1 day)

Receive push notifications from PVOutput when something's wrong.

- [ ] `modules/pvoutput/webhook.js` — Express router, accepts `POST /api/pvoutput/webhook` (application/x-www-form-urlencoded). **Validation (S5):** rate-limited at 10 req/min per IP via `express-rate-limit`; rejects requests where `sid` doesn't match configured `system_id` (403). Stores valid alerts in `pvoutput_alerts` table. Emits to dashboard via WebSocket broadcast.
- [ ] Database: `pvoutput_alerts` table
- [ ] Webhook registration: `GET registernotification.jsp` on config save if `webhook_url` is set. Deregistration on disable (`GET deregisternotification.jsp`). Registration skipped with UI notice if `webhook_url` is empty.
- [ ] Settings UI — webhook URL field, register/deregister buttons, alert list with acknowledge button
- [ ] Dashboard: notification badge with unacknowledged alert count
- [ ] API: `GET /api/pvoutput/alerts`, `POST /api/pvoutput/alerts/:id/ack`

### Phase 5 — Extended Data + Polish (1 day)

- [ ] Extended data v7–v12 uploads (gated on donation mode)
- [ ] Battery state derivation (SOC ≥ 95 → Full, SOC ≤ 5 → Flat, b1 > 0 → Charging, b1 < 0 → Discharging)
- [ ] Settings UI — extended data mapping dropdowns (shown only when donation mode detected). **Includes note (M10):** *"Configure these channels in your PVOutput account under System → Extended Data before mapping here."*
- [ ] Rate limit warning banner when any pool has < 10 remaining
- [ ] README.md update — PVOutput section with setup steps, metric mapping guide, troubleshooting

---

## Database Changes

Add `pvoutput_config` to `essentialKeys` in `database.js`.

Five new tables (created in `server.js` startup) + one config key for stats cache:

| Table / Key | Purpose | Notes |
|---|---|---|
| `pvoutput_upload_queue` | Failed/pending uploads for backfill | Index on `(date, status)` per GM6 |
| `pvoutput_history` | Status data fetched from PVOutput | Index on `date` |
| `pvoutput_daily_outputs` | End-of-day summary records | `date` PK, `status TEXT` (M6), `attempts INTEGER DEFAULT 0` (NC3), `source TEXT NOT NULL DEFAULT 'push'` (GC1) |
| `pvoutput_alerts` | Webhook alert notifications | Index on `alert_type, acknowledged` |
| `pvoutput_system` | Cached system info from getsystem | `system_id` PK |
| `pvoutput_stats_cache` | Aggregate statistics from getstatistic | Config table key, JSON blob with `fetched_at` (M7) |

---

## server.js Integration

```js
const pvoutput = require('./modules/pvoutput');
const { router: pvoutputWebhookRouter } = require('./modules/pvoutput/webhook');

// Routes — registered ONCE at startup, never re-registered (HC1).
// Express app.use() is additive; calling it twice duplicates handlers.
app.use('/api/pvoutput/webhook', pvoutputWebhookRouter);
app.use('/api/pvoutput', isAuthenticated, pvoutput.router);  // exported from pvoutput.js (SC1)

// Engine lifecycle — safe to call multiple times.
// restart() stops and restarts setInterval loops only (push, pull, backfill).
// It reloads config from DB on each call. Routes are untouched.
// Module imports getDb/logger internally; no arguments needed (RC1).
pvoutput.start();

// Config change — restarts engines only, does not re-register routes.
if ('pvoutput_config' in updates) pvoutput.restart();
```

---

## Settings UI Layout

New sub-tab "PVOutput" under Data Sources (same pattern as BMS and Dongle):

- Enable checkbox, API Key (password field), System ID
- Timezone field (pre-filled from `getsystem` on test; editable before first test)
- Donation mode: read-only indicator ("Yes ✓" / "No") + "Re-detect" button (M9). Auto-detected from rate limit headers on any API response.
- Upload interval (5/10/15 min), System size (W)
- Test Connection button — calls `fetchSystemInfo()` (M8), shows system name + rate limit remaining from both pools
- Metric mapping: v1–v6 dropdowns populated from metrics store, unit toggle (kWh → Wh conversion)
- Battery section: enable checkbox, b1 power metric, SOC metric
- Extended data v7–v12 (shown when donation detected). **Note (M10):** *"Configure these channels in your PVOutput account under System → Extended Data before mapping here."*
- Cumulative mode (c1) / Net data mode (n) radio — mutually exclusive
- Webhook URL + register/deregister buttons (optional, skipped if URL empty)
- Upload queue status: pending count grouped by date, last upload timestamp, "Run Backfill" button

---

## Error Handling Summary

| Scenario | Response |
|---|---|
| 401 (bad key/ID) | Disable uploads, red banner in settings, no retry |
| 429 — general pool exhausted | Parse `X-Rate-Limit-Reset`, pause general calls until reset, queue uploads for backfill |
| 429 — statistic pool exhausted | Pause only `getstatistic` calls until reset; general pool unaffected (S4) |
| Network timeout | Queue for backfill, retry next interval |
| PVOutput 500/503 | Exponential backoff: 1m → 2m → 5m → 15m |
| "Energy too low" (400) | Skip, log warning (inverter midnight reset — don't queue for retry) |
| "No sun" (400) | Suppress — expected at night, don't queue |
| "Power too large" (400) | Log warning with actual vs allowed, possible wrong metric mapping |
| "Energy value cannot be lower" (400) | Likely midnight boundary in batch — backfill invariant should prevent this (C2) |
| EOD upload fails | Retry at 00:15 and 01:00 via polling loop (S3/FM5), then set `status = 'failed'` after 3 attempts |
| Backfill response: "Updated Status" | Log as distinct from "Added Status" (M11); queue entry still marked `uploaded` |
| Backfill exceeds batch limit | Chunk into per-date groups (C2), 10s delay between calls |
| Backfill older than lookback | Mark queue entry as `expired`, discard |
| Webhook: mismatched SID | 403 Forbidden (S5) |
| Webhook: rate limited | 429 via `express-rate-limit` (S5) |

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| PVOutput API changes | Low | API has been stable 10+ years; use versioned base URL `/r2/` |
| Free tier too restrictive (60/hr) | Medium | 5-min interval = 12/hr for uploads, 48/hr headroom. Document donation benefits. |
| Users confused by cumulative vs net mode | Medium | Default to c1=1 (cumulative — matches dongle daily totals). Net mode hidden behind advanced toggle. |
| No public URL for webhook | High | Make webhook optional. All core features work without it. Show "requires public URL" note in UI. |
| Inverter midnight reset causes "energy too low" | Medium | Catch and log only — no queue retry for this specific error since it's a data issue, not a connectivity issue. |

---

## Estimated Timeline

| Phase | What | Days |
|---|---|---|
| 1 | Push — live status upload | 2–3 |
| 2 | End of day + backfill | 1–2 |
| 3 | Pull + history + dashboard | 1–2 |
| 4 | Webhook + alerts | 1 |
| 5 | Extended data + polish | 1 |
| **Total** | | **6–9** |
