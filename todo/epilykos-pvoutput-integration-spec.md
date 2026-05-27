# Epilykos — PVOutput Integration: Technical Implementation Specification

**Feature:** `pvoutput` module — bidirectional PVOutput.org integration  
**Target branch:** `feature/pvoutput-integration`  
**PVOutput API base URL:** `https://pvoutput.org/service/r2/`  
**Document status:** Draft v1.0

---

## Table of Contents

1. [Overview & Integration Model](#1-overview--integration-model)
2. [PVOutput API Reference Summary](#2-pvoutput-api-reference-summary)
   - 2.1 Authentication
   - 2.2 Rate Limits
   - 2.3 Service Catalogue
3. [Add Status Service — Full Parameter Reference](#3-add-status-service--full-parameter-reference)
4. [Add Batch Status Service](#4-add-batch-status-service)
5. [Add Output Service (End of Day)](#5-add-output-service-end-of-day)
6. [Get Status Service](#6-get-status-service)
7. [Get Statistic Service](#7-get-statistic-service)
8. [Get Output Service](#8-get-output-service)
9. [Get System Service](#9-get-system-service)
10. [Delete Status Service](#10-delete-status-service)
11. [Register / Deregister Notification Service](#11-register--deregister-notification-service)
12. [Epilykos Architecture: Module Design](#12-epilykos-architecture-module-design)
13. [Metric Mapping: Epilykos → PVOutput](#13-metric-mapping-epilykos--pvoutput)
14. [Push Engine: Upload Scheduler](#14-push-engine-upload-scheduler)
15. [Pull Engine: Data Retrieval](#15-pull-engine-data-retrieval)
16. [Webhook Receiver: Notification Callbacks](#16-webhook-receiver-notification-callbacks)
17. [Rate Limit Management](#17-rate-limit-management)
18. [Database Schema](#18-database-schema)
19. [API Routes (Epilykos Internal)](#19-api-routes-epilykos-internal)
20. [Settings UI](#20-settings-ui)
21. [server.js Integration](#21-serverjs-integration)
22. [Error Handling & Resilience](#22-error-handling--resilience)
23. [Implementation Phases](#23-implementation-phases)

---

## 1. Overview & Integration Model

PVOutput.org is a community platform for logging, sharing, and comparing solar energy system
performance. The Epilykos PVOutput integration operates in three directions simultaneously:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Epilykos                                  │
│                                                                  │
│  ┌──────────────┐  PUSH (upload)   ┌────────────────────────┐  │
│  │ Metrics Store│ ──────────────►  │   modules/pvoutput.js  │  │
│  └──────────────┘                  │                        │  │
│                                    │  ● Upload Scheduler    │◄─────► pvoutput.org
│  ┌──────────────┐  PULL (retrieve) │  ● Data Fetcher        │       API
│  │  SQLite DB   │ ◄──────────────  │  ● Webhook Receiver    │
│  └──────────────┘                  │  ● Rate Limiter        │  │
│                                    └────────────────────────┘  │
│  ┌──────────────┐  ALERTS                      ▲               │
│  │  Dashboard   │ ◄────────────────────────────┘               │
│  └──────────────┘  (notification callbacks)                     │
└─────────────────────────────────────────────────────────────────┘
```

### Integration modes

**PUSH — Epilykos → PVOutput:** Epilykos reads from the live metrics store (solar power,
battery, grid, consumption data) and uploads status records to PVOutput on a scheduled
interval (default: every 5 minutes). At end of day it automatically submits a daily Output
record. A backfill mechanism handles missed uploads using stored historical data.

**PULL — PVOutput → Epilykos:** Epilykos fetches historical status data, daily outputs,
and system statistics from PVOutput for use in dashboard charts, performance comparisons,
and data recovery. Pull operations are rate-limited and cached to stay within API quotas.

**ALERTS — PVOutput → Epilykos webhook:** Epilykos registers a notification endpoint with
PVOutput. When PVOutput triggers an alert (high consumption, low generation, system idle,
etc.), it calls back to Epilykos, which logs the alert and optionally surfaces it in the
dashboard notification panel.

---

## 2. PVOutput API Reference Summary

### 2.1 Authentication

Every request requires two HTTP headers:

```
X-Pvoutput-Apikey: <api_key>          — API key from PVOutput account settings
X-Pvoutput-SystemId: <system_id>      — Numeric system ID from PVOutput
```

These are never sent as query parameters or POST body fields. They are always headers.

To retrieve rate limit information without triggering a payload call, add:

```
X-Rate-Limit: 1
```

to any request. The response headers will contain rate limit data without consuming a
meaningful API call.

### 2.2 Rate Limits

| Account Type | Requests/Hour | Batch Size | History Lookback | Backfill Window |
|---|---|---|---|---|
| Standard (free) | 60 | 30 statuses | 7 days live | 14 days |
| Donation | 300 | 100 statuses | Full history | 90 days addstatus / 100 days backfill |

Rate limit state is communicated in response headers on every API call:

```
X-Rate-Limit-Limit: 300          — total allowed per hour
X-Rate-Limit-Remaining: 271      — remaining in current window
X-Rate-Limit-Reset: 1570597200   — Unix timestamp when window resets
```

Requests exceeding the limit return HTTP 429. The module must respect the remaining/reset
headers to avoid blacklisting.

**Practical guidance for Epilykos:**
- A 5-minute status upload interval = 12 API calls/hour (well within free tier of 60)
- End-of-day output = 1 call/day
- Statistic fetches = 1 call (cached 24h by PVOutput)
- Reserve ~10 calls/hour for pull operations and backfill
- Total comfortable budget: ~25 calls/hour, leaving 35 in reserve

### 2.3 Service Catalogue

| Service | Endpoint | Method | Direction | Donation Required |
|---|---|---|---|---|
| Add Status | `/addstatus.jsp` | POST | PUSH | No (some params) |
| Add Batch Status | `/addbatchstatus.jsp` | POST | PUSH | Yes |
| Add Output | `/addoutput.jsp` | POST | PUSH | No |
| Get Status | `/getstatus.jsp` | GET | PULL | No (some params) |
| Get Statistic | `/getstatistic.jsp` | GET | PULL | No |
| Get Output | `/getoutput.jsp` | GET | PULL | No |
| Get System | `/getsystem.jsp` | GET | PULL | No |
| Delete Status | `/deletestatus.jsp` | POST | ADMIN | No |
| Register Notification | `/registernotification.jsp` | GET | WEBHOOK | No |
| Deregister Notification | `/deregisternotification.jsp` | GET | WEBHOOK | No |

---

## 3. Add Status Service — Full Parameter Reference

**Endpoint:** `POST https://pvoutput.org/service/r2/addstatus.jsp`  
**Purpose:** Upload live energy data at the system's configured status interval (5–15 min)

### Standard Parameters

| Parameter | Field Name | Type | Unit | Required | Description |
|---|---|---|---|---|---|
| `d` | Date | string `yyyymmdd` | — | Yes | Upload date. Max 14 days back (90 days donation) |
| `t` | Time | string `hh:mm` | — | Yes | Upload time. Rounded to 5-min intervals |
| `v1` | Energy Generation | integer | Wh | No* | Cumulative generation today. Range: 0–9,999,999 (std) |
| `v2` | Power Generation | integer | W | No* | Instantaneous power being generated |
| `v3` | Energy Consumption | integer | Wh | No* | Cumulative consumption today. Max 200,000 Wh (5,000,000 donation) |
| `v4` | Power Consumption | integer | W | No* | Instantaneous power being consumed. Max 200,000 W (2,000,000 donation) |
| `v5` | Temperature | decimal | °C | No | Ambient temperature at time of upload |
| `v6` | Voltage | decimal | V | No | Mains/grid voltage |
| `c1` | Cumulative Flag | integer | — | No | `1`=both v1+v3 are lifetime totals; `2`=v1 only; `3`=v3 only |
| `n` | Net Data Flag | integer | — | No | `1`=v2 is net export, v4 is net import (cannot combine with c1) |

*At least one of v1/v2 (generation) or v3/v4 (consumption) must be present.

### Battery Parameters (all require `b1`)

| Parameter | Field Name | Type | Unit | Description |
|---|---|---|---|---|
| `b1` | Battery Power | integer | W | Current battery power. Positive=charging, negative=discharging. MANDATORY for battery data. |
| `b2` | Battery State | integer | code | See Battery State Codes table below |

**Battery State Codes:**

| Code | State |
|---|---|
| 0 | Idle / No data |
| 1 | Discharging |
| 2 | Charging |
| 3 | Full |
| 4 | Flat |
| 5 | Grid charged |

### Extended Data Parameters (Donation only)

| Parameter | Description | Value range |
|---|---|---|
| `v7` | User-defined extended channel 1 | Any decimal, negative allowed |
| `v8` | User-defined extended channel 2 | Any decimal, negative allowed |
| `v9` | User-defined extended channel 3 | Any decimal, negative allowed |
| `v10` | User-defined extended channel 4 | Any decimal, negative allowed |
| `v11` | User-defined extended channel 5 | Any decimal, negative allowed |
| `v12` | User-defined extended channel 6 | Any decimal, negative allowed |

Extended channels must be configured in the PVOutput system settings before they appear
on the graph. Each channel has a configurable: label, unit, colour, graph type (line/area),
axis (0–5 for multi-axis grouping), and summary behaviour (end-of-day value selection).

### Cumulative Flag (`c1`) Behaviour

| c1 value | Meaning |
|---|---|
| Not set | v1/v3 are interval energy values (Wh generated/consumed since last upload) |
| `1` | Both v1 and v3 are lifetime values (reset to 0 at midnight, not interval) |
| `2` | Only v1 (generation) is a lifetime value |
| `3` | Only v3 (consumption) is a lifetime value |

For inverters that report daily cumulative totals (e.g. `daily_solar_kwh` from the dongle
module), use `c1=1`. For inverters that report instantaneous power only (v2/v4), omit c1.
Energy values are auto-derived from power values by PVOutput.

### Net Data Flag (`n`) Behaviour

When `n=1`, v2 represents net export (positive) or net import (negative), and v4 represents
net import (positive) or net export (negative). PVOutput merges this with existing generation
data to derive gross consumption. Cannot be combined with `c1`.

| v2 value | v4 value | Result |
|---|---|---|
| Positive | Positive | v2 = export, v4 = import |
| Negative | Positive | v4 = import + abs(v2) as additional import |
| Positive | Negative | v2 = export + abs(v4) as additional export |
| Negative | Negative | Both treated as import |

### Success Response

```
HTTP 200 OK
Body: "OK 200: Added Status"  (new entry)
      "OK 200: Updated Status" (updating existing time slot)
```

### Validation Errors

| Error | Cause |
|---|---|
| `Date is out of range` | d older than 14 days (or 90 days donation) |
| `Power too large` | v2 or v4 > 150% of system rated size |
| `Energy value too low` | v1/v3 lower than previously recorded value (can't decrease) |
| `No sun` | Upload time is outside daylight hours for system timezone |
| `Data cannot be both cumulative and net` | c1 and n both set |
| `Missing b1` | Battery params sent without mandatory b1 |

---

## 4. Add Batch Status Service

**Endpoint:** `POST https://pvoutput.org/service/r2/addbatchstatus.jsp`  
**Purpose:** Upload multiple status records in a single request (backfill, gap-fill)  
**Requires:** Donation mode

### Parameters

| Parameter | Description |
|---|---|
| `data` | Semicolon-delimited list of status records (see format below) |
| `c1` | Cumulative flag, applied to all records in batch |
| `n` | Net data flag, applied to all records in batch |

### Batch Data Format

```
data=<record1>;<record2>;...;<recordN>
```

Each record is comma-delimited:

```
date,time,v1,v2,v3,v4,v5,v6
```

Fields that are not provided must be left empty (comma placeholder retained):

```
20250522,10:00,1500,,3000,,25.5,239.1
20250522,10:05,1600,,3200,,,          ← trailing empty fields can be omitted
20250522,10:10,,2400,,1800,,
```

Extended data (v7–v12) appended after v6, comma-delimited, donation only:

```
20250522,10:00,1500,2400,3000,1800,25.5,239.1,0.82,,,45.2,,
```

### Limits

| Account | Max records per call | Max date lookback |
|---|---|---|
| Standard | 30 | 14 days |
| Donation | 100 | 90 days |

### Use in Epilykos

Batch status is used by the **backfill engine** when Epilykos has been offline and has
missed upload windows. The backfill engine reads the `pvoutput_upload_queue` table,
groups pending uploads into batches of up to 100 records, and submits them as batch
requests rather than individual `addstatus` calls, conserving rate limit budget.

---

## 5. Add Output Service (End of Day)

**Endpoint:** `POST https://pvoutput.org/service/r2/addoutput.jsp`  
**Purpose:** Upload end-of-day summary statistics. Should be submitted once per day at
or after midnight.

### Single-Day Parameters

| Parameter | Field Name | Type | Unit | Required | Description |
|---|---|---|---|---|---|
| `d` | Output Date | string `yyyymmdd` | — | Yes | The date being reported |
| `g` | Energy Generated | integer | Wh | No* | Total generation for the day |
| `pp` | Peak Power | integer | W | No | Peak generation power reached |
| `pt` | Peak Time | string `hh:mm` | — | No | Time of peak power |
| `cd` | Condition | string | — | No | Weather condition (Fine, Cloudy, etc.) |
| `tm` | Min Temperature | decimal | °C | No | Minimum temperature for the day |
| `tx` | Max Temperature | decimal | °C | No | Maximum temperature for the day |
| `cm` | Comments | string (max 30) | — | No | Free-text comment |
| `ip` | Import Peak (Wh) | integer | Wh | No | Energy imported during peak tariff period |
| `io` | Import Off-Peak (Wh) | integer | Wh | No | Energy imported during off-peak tariff period |
| `is` | Import Shoulder (Wh) | integer | Wh | No | Energy imported during shoulder period |
| `ih` | Import High Shoulder (Wh) | integer | Wh | No | Energy imported during high-shoulder period |
| `c` | Consumption | integer | Wh | No | Total consumption for the day |
| `ep` | Export Peak (Wh) | integer | Wh | No | Energy exported during peak tariff period |
| `es` | Export Off-Peak (Wh) | integer | Wh | No | Energy exported during off-peak period |

*At least one energy value (g or c) must be present.

### Batch Output Format

Multiple days can be submitted in one call using semicolon-delimited records:

```
data=date,g,pp,pt,cd,tm,tx,cm,ep,ip,io,is,ih,c,es,ep2,...
```

Example — three days:

```
data=20250520,18500,3400,13:15,Fine,14.2,28.7,,,,,,;
     20250521,12300,2100,11:45,Cloudy,15.0,24.0,,,,,,;
     20250522,21000,3800,13:00,Fine,16.5,31.2,,,,,,
```

### Weather Condition Codes

```
Fine, Mostly Fine, Partly Cloudy, Mostly Cloudy, Cloudy, Overcast, Foggy, Showers, Rain, Thunderstorm, Snow
```

### Use in Epilykos

The end-of-day job runs as a scheduled task at `23:55` local time. It reads the day's
accumulated totals from the `daily_stats` SQLite table (or derives them from the metrics
store), finds the peak generation record, and submits `addoutput`. A separate overnight
job at `00:15` verifies the previous day's output was received and re-submits if not.

---

## 6. Get Status Service

**Endpoint:** `GET https://pvoutput.org/service/r2/getstatus.jsp`  
**Purpose:** Retrieve current or historical live status data from PVOutput  
**Rate limit:** Counts toward the general hourly limit (60/300)

### Parameters

| Parameter | Description | Default |
|---|---|---|
| `d` | Date `yyyymmdd` to retrieve | Last known live data (within 7 days) |
| `t` | Time `hh:mm` — if set with `h=1`, only statuses after this time are returned | — |
| `h` | History flag. `1` = return full day history, not just latest | 0 |
| `limit` | Max records to return when `h=1` | 30 (use 288 for full 24h at 5-min intervals) |
| `asc` | `1` = ascending time order (oldest first). Default is descending. | 0 |
| `ext` | `1` = include extended data v7–v12 in response (donation only) | 0 |
| `sid` | System ID to query (donation only — read another system's public data) | Own system |

### Response Format — Single Status

```
date,time,energy_gen,power_gen,energy_con,power_con,efficiency,temperature,voltage,NaN,NaN
```

Example:

```
20250522,10:40,1850,2400,3100,1800,0.082,24.5,239.2,NaN,NaN
```

| Position | Field | Unit | Notes |
|---|---|---|---|
| 0 | Date | yyyymmdd | |
| 1 | Time | hh:mm | |
| 2 | Energy Generated | Wh | Cumulative for day |
| 3 | Power Generated | W | Instantaneous |
| 4 | Energy Consumed | Wh | Cumulative for day |
| 5 | Power Consumed | W | Instantaneous |
| 6 | Efficiency | kWh/kW | System normalised output |
| 7 | Temperature | °C | `NaN` if not provided |
| 8 | Voltage | V | `NaN` if not provided |
| 9 | Extended v7 | — | `NaN` if not provided / not donation |
| 10 | Extended v8 | — | `NaN` if not provided |
| ... | Extended v9–v12 | — | |

### Response Format — History Mode (`h=1`)

Multiple records separated by semicolons:

```
20200228,10:40,359,480,731,732,0.082,92,130,NaN,NaN;
20200228,10:35,298,360,710,708,0.067,81,130,NaN,NaN;
20200228,10:30,239,240,710,708,0.054,70,130,NaN,NaN
```

Statuses returned in descending order by default. Use `asc=1` to reverse.

### Use in Epilykos

`getstatus` is used by the **data recovery engine**: when Epilykos detects a gap in its
local SQLite history (missed uploads due to downtime), it fetches the missing period from
PVOutput rather than reporting zero data, preserving dashboard accuracy.

It is also used by the **comparison panel**: fetch a neighbour system's data using `sid`
(donation) and display a side-by-side daily generation comparison chart.

---

## 7. Get Statistic Service

**Endpoint:** `GET https://pvoutput.org/service/r2/getstatistic.jsp`  
**Purpose:** Retrieve aggregated system statistics over a date range  
**Rate limit:** 12/hour (standard), 60/hour (donation). Results cached 24h by PVOutput.

### Parameters

| Parameter | Description |
|---|---|
| `df` | From date `yyyymmdd`. If omitted, returns lifetime statistics. |
| `dt` | To date `yyyymmdd` |
| `c` | `1` = include consumption data (owner only) |
| `crdr` | `1` = include credit/debit cost data (owner only) |
| `sid` | System ID to query (donation only, for public systems) |
| `type` | Aggregate type: `0`=exact, `1`=day, `2`=month, `4`=year |

### Response Format

Comma-delimited single line:

```
energy_generated,energy_efficiency,energy_exported,energy_imported,avg_power_gen,avg_power_con,record_efficiency,record_date_start,record_date_end,record_efficiency2,record_date2
```

Example:

```
124600,14220,2220,800,3400,3.358,27,20210201,20210228,4.653,20210205
```

| Position | Field | Unit | Notes |
|---|---|---|---|
| 0 | Energy Generated | Wh | Total for period |
| 1 | Energy Efficiency | Wh/kW | Normalised by system size |
| 2 | Energy Exported | Wh | |
| 3 | Energy Imported | Wh | |
| 4 | Average Power Generated | W | |
| 5 | Average Generation Efficiency | kWh/kW/day | |
| 6 | Record Efficiency | Wh/kW | Best day in period |
| 7 | Record Date Start | yyyymmdd | |
| 8 | Record Date End | yyyymmdd | Where multiple dates tie |
| 9 | Record Efficiency (all time) | Wh/kW | |
| 10 | Record Date (all time) | yyyymmdd | |

### Use in Epilykos

Fetched once daily (cached 24h by PVOutput anyway). Results populate:
- The "Lifetime Stats" panel in the dashboard (total generation, best day, average)
- The "Performance" chart (efficiency trend over selectable period)
- The export report (monthly/annual summaries)

---

## 8. Get Output Service

**Endpoint:** `GET https://pvoutput.org/service/r2/getoutput.jsp`  
**Purpose:** Retrieve historical daily output records

### Parameters

| Parameter | Description |
|---|---|
| `df` | From date `yyyymmdd` |
| `dt` | To date `yyyymmdd` |
| `d` | Specific date (alternative to df/dt) |
| `a` | Aggregate: `d`=daily (default), `m`=monthly, `y`=yearly |
| `limit` | Max records (default 30) |
| `sid` | System ID (donation, other systems) |
| `c` | `1` = include consumption |

### Response Format

One output record per line (or semicolon-delimited for batch):

```
date,energy_gen,efficiency,energy_exp,energy_imp,peak_power,peak_time,condition,min_temp,max_temp,comments,peak_exp,off_peak_exp,consumption,exported
```

### Use in Epilykos

Used to backfill the local `daily_outputs` SQLite table when Epilykos has been offline.
Also powers the **monthly report** and **calendar heatmap** views on the dashboard.

---

## 9. Get System Service

**Endpoint:** `GET https://pvoutput.org/service/r2/getsystem.jsp`  
**Purpose:** Retrieve registered system information  
**Also used for:** Rate limit header check (add `X-Rate-Limit: 1` header)

### Response Format

```
system_name,system_size,postcode,num_panels,panel_power,panel_brand,num_inverters,inverter_power,inverter_brand,orientation,array_tilt,shade,install_date,latitude,longitude,status_interval,secondary_name,...
```

### Use in Epilykos

Fetched once at startup and cached. Used to:
- Pre-fill the "system size" reference for efficiency calculations
- Confirm the API key and system ID are valid (returns 401 if invalid)
- Display system information on the dashboard info panel

---

## 10. Delete Status Service

**Endpoint:** `POST https://pvoutput.org/service/r2/deletestatus.jsp`  
**Purpose:** Delete a specific status entry or all entries for a date

### Parameters

| Parameter | Description | Required |
|---|---|---|
| `d` | Date `yyyymmdd` of entry to delete | Yes |
| `t` | Time `hh:mm` of specific entry to delete | No — omit to delete all entries for the day |

### Use in Epilykos

Exposed in the settings UI as an admin tool for data correction. Also used internally by
the **re-upload tool**: when a day's data needs correcting (e.g. wrong c1 flag was used),
Epilykos can delete all entries for that date and re-upload from local history.

---

## 11. Register / Deregister Notification Service

### Register

**Endpoint:** `GET https://pvoutput.org/service/r2/registernotification.jsp`  
**Purpose:** Register a callback URL that PVOutput will POST to when alerts trigger

| Parameter | Type | Max Length | Description |
|---|---|---|---|
| `appid` | string | 100 | Application identifier (e.g. `epilykos.pvoutput`) |
| `url` | string | 150 | Callback URL (must be publicly reachable, or use local tunnel) |
| `type` | integer | — | Alert type (see table below) |

### Deregister

**Endpoint:** `GET https://pvoutput.org/service/r2/deregisternotification.jsp`

| Parameter | Description |
|---|---|
| `appid` | Application identifier to deregister |
| `type` | Alert type to remove |

### Alert Type Reference

| Type | Alert |
|---|---|
| 0 | All Notifications |
| 1 | Private Message |
| 3 | Joined Team |
| 4 | Added Favourite |
| 5 | High Consumption Alert |
| 6 | System Idle Alert |
| 8 | Low Generation Alert |
| 11 | Performance Alert |
| 14 | Standby Cost Alert |
| 15 | Extended Data V7 Alert |
| 16 | Extended Data V8 Alert |
| 17 | Extended Data V9 Alert |
| 18 | Extended Data V10 Alert |
| 19 | Extended Data V11 Alert |
| 20 | Extended Data V12 Alert |
| 23 | High Net Power Alert |
| 24 | Low Net Power Alert |

### Callback Payload

PVOutput POSTs to the registered URL with an application/x-www-form-urlencoded body:

```
sid=12345&type=5&message=High+Consumption+Alert&datetime=20250522143000
```

### Use in Epilykos

The notification endpoint (`POST /api/pvoutput/webhook`) is registered on first
PVOutput config save if a public URL is configured. Incoming alerts are:
- Written to the `pvoutput_alerts` SQLite table
- Surfaced in the dashboard notification tray
- Optionally forwarded to the Epilykos Home Assistant instance as an HA notification

Note: The callback URL must be publicly reachable by PVOutput's servers.
Users without a public URL (home LAN only) can skip webhook registration; push/pull
still functions without it.

---

## 12. Epilykos Architecture: Module Design

### File Structure

```
epilykos/
├── modules/
│   ├── pvoutput.js              ← Main module: export start/stop, orchestrates all engines
│   └── pvoutput/
│       ├── client.js            ← PVOutput HTTP client (auth headers, rate limit tracking)
│       ├── push.js              ← Upload scheduler: addstatus, addoutput
│       ├── pull.js              ← Data fetcher: getstatus, getstatistic, getoutput, getsystem
│       ├── backfill.js          ← Gap detection and batch re-upload engine
│       ├── webhook.js           ← Express router for notification callback endpoint
│       ├── mapper.js            ← Maps Epilykos metric names → PVOutput parameters
│       └── rateLimiter.js       ← Token bucket rate limiter with persistent state
├── public/
│   ├── settings.html            ← ADD: PVOutput section
│   └── settings.js              ← ADD: PVOutput section handlers
└── routes/
    └── pvoutput-routes.js       ← Internal Epilykos API routes for PVOutput operations
```

### Module Contract

```js
// modules/pvoutput.js
module.exports = {
  async start(db, metricsStore, logger, app),  // initialise, register webhook route
  async stop(),                                 // stop schedulers, flush queue
  getStatus(),                                  // return current state for settings UI
};
```

---

## 13. Metric Mapping: Epilykos → PVOutput

The mapper (`modules/pvoutput/mapper.js`) converts Epilykos named metrics into PVOutput
parameters. The mapping is driven by user configuration in the settings UI, with sensible
defaults for standard metric names.

### Default Mapping

| PVOutput Param | Epilykos Metric (default) | Notes |
|---|---|---|
| `v1` | `daily_solar_kwh` × 1000 | Wh. Convert from kWh. Use c1 mode. |
| `v2` | `solar_power` | W instantaneous |
| `v3` | `daily_load_kwh` × 1000 | Wh. If available from dongle/HA. |
| `v4` | `load_power` | W instantaneous |
| `v5` | `inverter_temperature` | °C. Or use a HA weather temp sensor. |
| `v6` | `grid_voltage` | V |
| `b1` | `battery_power` | W. Positive=charge, negative=discharge. |
| `b2` | Derived from `battery_soc` | `3`=Full (≥95%), `4`=Flat (≤5%), `2`=Charging (b1>0), `1`=Discharging (b1<0) |
| `v7` | `battery_soc` | Extended — donation only |
| `v8` | `grid_power` | Extended. Positive=import, negative=export. |
| `v9` | `battery_voltage` | Extended |
| `v10` | *(user configurable)* | Extended |
| `v11` | *(user configurable)* | Extended |
| `v12` | *(user configurable)* | Extended |

### Cumulative Mode Selection

The mapper must know whether the source metric is a daily cumulative or an instantaneous value:

```js
// modules/pvoutput/mapper.js

function buildStatusPayload(metrics, config, timestamp) {
  const payload = {
    d: formatDate(timestamp),   // yyyymmdd
    t: formatTime(timestamp),   // hh:mm
  };

  // Energy generation — prefer cumulative daily value
  if (metrics[config.v1_metric] != null) {
    const raw = metrics[config.v1_metric];
    // Convert kWh → Wh if metric is in kWh
    payload.v1 = Math.round(raw * (config.v1_is_kwh ? 1000 : 1));
    payload.c1 = config.c1_mode || 1; // default: daily cumulative
  }

  // Instantaneous power generation
  if (metrics[config.v2_metric] != null) {
    payload.v2 = Math.round(metrics[config.v2_metric]);
  }

  // Energy consumption
  if (metrics[config.v3_metric] != null) {
    payload.v3 = Math.round(metrics[config.v3_metric] * (config.v3_is_kwh ? 1000 : 1));
  }

  // Power consumption
  if (metrics[config.v4_metric] != null) {
    payload.v4 = Math.round(metrics[config.v4_metric]);
  }

  // Temperature & voltage
  if (metrics[config.v5_metric] != null) payload.v5 = +metrics[config.v5_metric].toFixed(1);
  if (metrics[config.v6_metric] != null) payload.v6 = +metrics[config.v6_metric].toFixed(1);

  // Battery
  if (config.battery_enabled && metrics[config.b1_metric] != null) {
    payload.b1 = Math.round(metrics[config.b1_metric]);
    payload.b2 = deriveBatteryState(metrics, config);
  }

  // Extended data (donation only)
  if (config.donation_mode) {
    for (let i = 7; i <= 12; i++) {
      const m = config[`v${i}_metric`];
      if (m && metrics[m] != null) {
        payload[`v${i}`] = +metrics[m].toFixed(2);
      }
    }
  }

  return payload;
}

function deriveBatteryState(metrics, config) {
  const soc = metrics[config.soc_metric];
  const power = metrics[config.b1_metric];
  if (soc >= 95) return 3;   // Full
  if (soc <= 5)  return 4;   // Flat
  if (power > 10) return 2;  // Charging
  if (power < -10) return 1; // Discharging
  return 0;                  // Idle
}
```

### Validation Before Upload

```js
function validatePayload(payload, systemSizeW) {
  const errors = [];

  // Must have at least one generation or consumption value
  if (!payload.v1 && !payload.v2 && !payload.v3 && !payload.v4) {
    errors.push('No energy or power values to upload');
  }

  // Power sanity check: > 150% of system size is rejected by PVOutput
  if (payload.v2 && systemSizeW && payload.v2 > systemSizeW * 1.5) {
    errors.push(`v2 power ${payload.v2}W > 150% of system size ${systemSizeW}W`);
  }

  // c1 and n cannot both be set
  if (payload.c1 && payload.n) {
    errors.push('c1 and n (net) cannot both be set');
  }

  // b1 must be present for any other battery params
  if ((payload.b2 != null) && payload.b1 == null) {
    errors.push('b2 requires b1');
  }

  return errors;
}
```

---

## 14. Push Engine: Upload Scheduler

**File:** `modules/pvoutput/push.js`

### Upload Interval

Default: 5 minutes (configurable 5–15 min to match PVOutput system setting).
The interval must match the system's configured status interval in PVOutput settings,
or PVOutput will reject uploads that are too frequent.

```js
class PVOutputPushEngine {
  constructor(client, metricsStore, db, config, logger) { ... }

  start() {
    // Align first upload to the next 5-minute boundary
    const msToNextInterval = getMillisecondsToNextInterval(this.config.interval_minutes);
    setTimeout(() => {
      this._upload();
      this.timer = setInterval(() => this._upload(), this.config.interval_minutes * 60 * 1000);
    }, msToNextInterval);

    // End-of-day job: 23:55 local time
    this._scheduleEod();
  }

  async _upload() {
    const now = new Date();
    const metrics = this.metricsStore.getAll();

    // Build payload
    const payload = buildStatusPayload(metrics, this.config, now);
    const errors = validatePayload(payload, this.config.system_size_w);
    if (errors.length > 0) {
      this.logger.warn(`[pvoutput] skipping upload: ${errors.join(', ')}`);
      this._queueForBackfill(payload, 'validation_failed');
      return;
    }

    try {
      await this.client.post('addstatus.jsp', payload);
      this._markUploaded(now);
      this.logger.debug(`[pvoutput] uploaded status at ${payload.t}`);
    } catch (err) {
      this.logger.warn(`[pvoutput] upload failed: ${err.message}`);
      // Queue for backfill — do NOT lose this data point
      this._queueForBackfill(payload, err.message);
    }
  }

  async _eodUpload() {
    // Build addoutput payload from daily totals
    const dailyStats = await this._getDailyStats();
    await this.client.post('addoutput.jsp', buildOutputPayload(dailyStats, this.config));
    this.logger.info('[pvoutput] end-of-day output uploaded');
  }

  _queueForBackfill(payload, reason) {
    // Insert into pvoutput_upload_queue table
    this.db.run(
      `INSERT INTO pvoutput_upload_queue (date, time, payload_json, reason, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [payload.d, payload.t, JSON.stringify(payload), reason]
    );
  }
}
```

### Upload Queue

Every failed or skipped upload is written to `pvoutput_upload_queue`. The backfill
engine processes this queue using batch uploads when conditions allow.

---

## 15. Pull Engine: Data Retrieval

**File:** `modules/pvoutput/pull.js`

### Scheduled Pull Operations

| Operation | Schedule | Rate limit cost | Caches to |
|---|---|---|---|
| `getsystem` | On startup, then 24h | 1 call | `pvoutput_system` table |
| `getstatistic` | Daily at 01:00 | 1 call | `pvoutput_stats` table |
| `getoutput` (last 30 days) | Daily at 01:30 | 1 call | `daily_outputs` table |
| `getstatus` (gap detection) | On startup, on demand | 1 per day fetched | `pvoutput_history` table |

### Gap Detection Algorithm

```js
async function detectAndFillGaps(db, client, config, logger) {
  // Find dates in the last 14 days where local pvoutput_history is missing
  const today = new Date();
  const lookback = config.donation_mode ? 90 : 14;

  for (let i = 1; i <= Math.min(lookback, 7); i++) {
    const date = subtractDays(today, i);
    const dateStr = formatDate(date); // yyyymmdd

    const localCount = db.get(
      'SELECT COUNT(*) as c FROM pvoutput_history WHERE date = ?', [dateStr]
    ).c;

    // A full day at 5-min intervals = 288 records × daylight fraction ≈ 96+ expected
    if (localCount < 50) {
      logger.info(`[pvoutput] gap detected on ${dateStr}, fetching from PVOutput`);
      const history = await client.get('getstatus.jsp', {
        d: dateStr, h: 1, limit: 288, asc: 1
      });
      await storeHistory(db, dateStr, parseStatusHistory(history));
    }
  }
}
```

---

## 16. Webhook Receiver: Notification Callbacks

**File:** `modules/pvoutput/webhook.js`

```js
const router = require('express').Router();

// PVOutput POSTs to this endpoint when an alert fires
router.post('/', express.urlencoded({ extended: false }), (req, res) => {
  const { sid, type, message, datetime } = req.body;

  if (!sid || !type) {
    return res.status(400).send('Bad Request');
  }

  // Store alert in DB
  db.run(
    `INSERT INTO pvoutput_alerts (system_id, alert_type, message, pvoutput_datetime, received_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [sid, type, message, datetime]
  );

  // Emit to dashboard via SSE/socket
  eventBus.emit('pvoutput:alert', { type, message, datetime });

  logger.info(`[pvoutput:webhook] alert type=${type}: ${message}`);
  res.status(200).send('OK');
});

module.exports = router;
```

### Webhook Registration

Epilykos registers the webhook on module start if `config.webhook_url` is set:

```js
async function registerWebhook(client, config) {
  await client.get('registernotification.jsp', {
    appid: 'epilykos.local',
    url: config.webhook_url,  // e.g. https://energy.yourdomain.com/api/pvoutput/webhook
    type: 0,                  // 0 = all alerts
  });
}
```

If the webhook URL is not configured (home LAN without public access), registration
is skipped and a notice is shown in the settings UI.

---

## 17. Rate Limit Management

**File:** `modules/pvoutput/rateLimiter.js`

All outbound API calls go through the rate limiter. It reads the `X-Rate-Limit-*` headers
from every response and maintains a real-time budget.

```js
class PVOutputRateLimiter {
  constructor(db) {
    this.remaining = 60;    // Conservative default
    this.limit = 60;
    this.resetAt = null;
    this.db = db;
  }

  // Called after every successful API response
  updateFromHeaders(headers) {
    this.remaining = parseInt(headers['x-rate-limit-remaining'] || this.remaining);
    this.limit = parseInt(headers['x-rate-limit-limit'] || this.limit);
    this.resetAt = parseInt(headers['x-rate-limit-reset'] || 0);
  }

  // Returns true if a call can be made, false if we should wait
  canCall(priority = 'normal') {
    if (this.remaining > 10) return true;           // Comfortable — proceed
    if (this.remaining > 3 && priority === 'high') return true;  // Reserved for uploads
    return false;                                   // Too close — wait
  }

  // Milliseconds until rate limit window resets
  msUntilReset() {
    if (!this.resetAt) return 0;
    return Math.max(0, (this.resetAt * 1000) - Date.now());
  }

  isDonationAccount() {
    return this.limit >= 300;
  }
}
```

### Priority Levels

| Operation | Priority | Behaviour when rate limited |
|---|---|---|
| addstatus (live upload) | `high` | Queue for backfill, log warning |
| addoutput (end of day) | `high` | Retry at 00:15, then 01:00 |
| addbatchstatus (backfill) | `normal` | Defer to next window |
| getstatus / getoutput | `low` | Defer indefinitely, use cached data |
| getstatistic | `low` | Use 24h cached value if available |

---

## 18. Database Schema

All PVOutput tables use the existing SQLite database. No separate database is created.

```sql
-- PVOutput configuration (stored in existing settings table as JSON)
-- Key: 'pvoutput_config'
-- Value: JSON object (see config structure below)

-- Upload queue: failed or pending uploads
CREATE TABLE IF NOT EXISTS pvoutput_upload_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,     -- yyyymmdd
  time         TEXT NOT NULL,     -- hh:mm
  payload_json TEXT NOT NULL,     -- full addstatus payload as JSON
  reason       TEXT,              -- why it was queued
  status       TEXT DEFAULT 'pending',  -- pending | uploaded | failed
  attempts     INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL,
  uploaded_at  TEXT
);

-- Historical status data fetched from PVOutput
CREATE TABLE IF NOT EXISTS pvoutput_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,     -- yyyymmdd
  time         TEXT NOT NULL,     -- hh:mm
  energy_gen   INTEGER,           -- Wh
  power_gen    INTEGER,           -- W
  energy_con   INTEGER,           -- Wh
  power_con    INTEGER,           -- W
  efficiency   REAL,
  temperature  REAL,
  voltage      REAL,
  UNIQUE(date, time)
);

-- Daily output records (from addoutput / getoutput)
CREATE TABLE IF NOT EXISTS pvoutput_daily_outputs (
  date         TEXT PRIMARY KEY,  -- yyyymmdd
  energy_gen   INTEGER,           -- Wh
  peak_power   INTEGER,           -- W
  peak_time    TEXT,              -- hh:mm
  energy_con   INTEGER,           -- Wh
  temperature_min REAL,
  temperature_max REAL,
  condition    TEXT,
  uploaded     INTEGER DEFAULT 0  -- 0=pending, 1=uploaded to PVOutput
);

-- Alert notifications received from PVOutput webhook
CREATE TABLE IF NOT EXISTS pvoutput_alerts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id        TEXT,
  alert_type       INTEGER,
  message          TEXT,
  pvoutput_datetime TEXT,
  received_at      TEXT NOT NULL,
  acknowledged     INTEGER DEFAULT 0
);

-- System info cached from getsystem
CREATE TABLE IF NOT EXISTS pvoutput_system (
  system_id    TEXT PRIMARY KEY,
  system_name  TEXT,
  system_size  INTEGER,  -- W
  postcode     TEXT,
  install_date TEXT,
  latitude     REAL,
  longitude    REAL,
  status_interval INTEGER,  -- minutes
  fetched_at   TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pvoutput_history_date ON pvoutput_history(date);
CREATE INDEX IF NOT EXISTS idx_pvoutput_queue_status ON pvoutput_upload_queue(status);
CREATE INDEX IF NOT EXISTS idx_pvoutput_alerts_type  ON pvoutput_alerts(alert_type, acknowledged);
```

### Configuration JSON Structure (`pvoutput_config` setting key)

```json
{
  "enabled": true,
  "api_key": "aabbcc...",
  "system_id": "12345",
  "donation_mode": false,
  "upload_interval_minutes": 5,
  "system_size_w": 5000,
  "c1_mode": 1,
  "net_mode": false,
  "battery_enabled": true,
  "webhook_url": "",
  "metric_map": {
    "v1": "daily_solar_kwh",
    "v1_is_kwh": true,
    "v2": "solar_power",
    "v3": "daily_load_kwh",
    "v3_is_kwh": true,
    "v4": "load_power",
    "v5": "inverter_temperature",
    "v6": "grid_voltage",
    "b1": "battery_power",
    "soc_metric": "battery_soc",
    "v7": "battery_soc",
    "v8": "grid_power",
    "v9": "battery_voltage",
    "v10": null,
    "v11": null,
    "v12": null
  }
}
```

---

## 19. API Routes (Epilykos Internal)

```
GET  /api/pvoutput/status              Current module state, rate limit, last upload time
GET  /api/pvoutput/queue               Contents of pvoutput_upload_queue (pending items)
POST /api/pvoutput/backfill            Trigger manual backfill of pending queue
POST /api/pvoutput/test                Send a single test status upload, return result
GET  /api/pvoutput/history?d=yyyymmdd  Retrieve history for a date (from local DB or PVOutput)
GET  /api/pvoutput/stats               System statistics (from cache or PVOutput)
POST /api/pvoutput/delete              Delete a PVOutput status entry
POST /api/pvoutput/webhook             PVOutput notification callback (external-facing)
GET  /api/pvoutput/alerts              List alerts from pvoutput_alerts table
POST /api/pvoutput/alerts/:id/ack      Acknowledge an alert
```

---

## 20. Settings UI

### New Section: "PVOutput" (tab in Data Sources or new top-level tab)

```
┌─ PVOutput Integration ─────────────────────────────────────────────────┐
│                                                                          │
│  ☑ Enable PVOutput Upload                                                │
│                                                                          │
│  API Key:       [aabbccdd1122334455667788eeff0011  ]                     │
│  System ID:     [12345      ]                                            │
│  ☐ Donation mode enabled (unlocks extended data, batch status, 300/hr)  │
│                                                                          │
│  Upload interval: [5 ▼] minutes   System size: [5000] W                 │
│                                                                          │
│  [Test Connection]  ● Connected — 271 calls remaining, resets 14:00     │
│                                                                          │
│  ── Metric Mapping ───────────────────────────────────────────────────  │
│  v1 Energy Gen:    [daily_solar_kwh ▼]  [kWh ▼]  Cumulative: [1 ▼]     │
│  v2 Power Gen:     [solar_power     ▼]                                   │
│  v3 Energy Con:    [daily_load_kwh  ▼]  [kWh ▼]                         │
│  v4 Power Con:     [load_power      ▼]                                   │
│  v5 Temperature:   [inverter_temperature ▼]                              │
│  v6 Voltage:       [grid_voltage    ▼]                                   │
│                                                                          │
│  ── Battery ──────────────────────────────────────────────────────────  │
│  ☑ Include battery data                                                  │
│  b1 Power:         [battery_power   ▼]                                   │
│  SOC metric:       [battery_soc     ▼]  (used to derive b2 state code)  │
│                                                                          │
│  ── Extended Data (Donation only) ────────────────────────────────────  │
│  v7: [battery_soc  ▼]   v8:  [grid_power    ▼]                          │
│  v9: [battery_voltage▼] v10: [none          ▼]                          │
│  v11:[none         ▼]   v12: [none          ▼]                          │
│                                                                          │
│  ── Upload Mode ──────────────────────────────────────────────────────  │
│  ◉ Cumulative (c1)  — energy values are daily running totals             │
│  ○ Net data (n)     — v2/v4 are net export/import values                 │
│                                                                          │
│  ── Notifications (optional) ─────────────────────────────────────────  │
│  Webhook URL:  [https://energy.yourdomain.com/api/pvoutput/webhook]      │
│  [Register Webhook]  [Deregister Webhook]                                │
│                                                                          │
│  ── Upload Queue ─────────────────────────────────────────────────────  │
│  Pending: 3 entries  [Run Backfill Now]  [View Queue]                    │
│  Last upload: 2 min ago (10:55)  ✓                                       │
│                                                                          │
│  [Save PVOutput Settings]                                                │
└──────────────────────────────────────────────────────────────────────────┘
```

### Test Connection Flow

`POST /api/pvoutput/test` calls `getsystem.jsp` with the entered credentials and returns:
- Success: system name, size, install date, current rate limit headers
- Failure: HTTP status and PVOutput error message

The metric mapping dropdowns are populated from the live metrics store keys — the same
approach used by the HA and MQTT module settings sections.

---

## 21. `server.js` Integration

```js
const pvoutput = require('./modules/pvoutput');

// In async startup, after metricsStore is initialised:
await pvoutput.start(db, metricsStore, logger, app);

// Register webhook route (public endpoint — no auth middleware)
app.use('/api/pvoutput/webhook', pvoutputWebhookRouter);

// Register authenticated internal routes
app.use('/api/pvoutput', isAuthenticated, pvoutputRouter);

// In graceful shutdown:
await pvoutput.stop();

// In POST /api/settings handler:
if ('pvoutput_config' in updates) await pvoutput.restart();
```

---

## 22. Error Handling & Resilience

| Scenario | Behaviour |
|---|---|
| API key invalid (401) | Disable uploads, surface error in settings UI, do not retry until key is updated |
| System ID mismatch (401) | Same as invalid key |
| Rate limit exceeded (429) | Parse reset timestamp, pause all calls until reset, queue uploads for backfill |
| Network unreachable | Queue upload for backfill, log warning, retry next interval |
| PVOutput 500/503 | Exponential backoff (1m → 2m → 5m → 15m), queue for backfill |
| `Energy value too low` (400) | Skip upload, log warning — inverter may have reset at midnight |
| `Power too large` (400) | Log warning with actual vs allowed values; may indicate wrong metric mapping |
| `No sun` (400) | Expected outside daylight hours — suppress warning, skip silently |
| `Data cannot be both cumulative and net` (400) | Configuration error — disable upload, alert user in settings UI |
| End-of-day upload fails | Retry at 00:15, 01:00, 02:00. After 3 failures, flag date in `pvoutput_daily_outputs` as `upload_failed` |
| Webhook delivery fails | PVOutput retries internally; Epilykos endpoint must return 200 promptly |
| Backfill exceeds donation batch limit | Chunk into groups of 100, submit with 10s delay between calls |
| Backfill data older than lookback window | Log and discard — PVOutput will reject; mark queue entry as `expired` |

---

## 23. Implementation Phases

### Phase 1 — Push (Live Status Upload) — 2–3 days

- [ ] `modules/pvoutput/client.js` — HTTP client with auth headers, rate limit header parsing
- [ ] `modules/pvoutput/rateLimiter.js` — token bucket with priority levels
- [ ] `modules/pvoutput/mapper.js` — metric name → PVOutput parameter mapping
- [ ] `modules/pvoutput/push.js` — `addstatus` scheduler, upload queue writes
- [ ] Database schema: `pvoutput_upload_queue`, `pvoutput_daily_outputs`
- [ ] `modules/pvoutput.js` — main module, start/stop
- [ ] `server.js` integration
- [ ] Settings UI — credentials, test button, basic metric mapping
- [ ] `GET /api/pvoutput/status`, `POST /api/pvoutput/test`

**Validation:** Live status appearing on pvoutput.org every 5 minutes with correct values.

### Phase 2 — End of Day & Backfill — 1–2 days

- [ ] `modules/pvoutput/push.js` — `_eodUpload()` scheduled job (23:55 + 00:15 retry)
- [ ] `modules/pvoutput/backfill.js` — gap detection, queue processing, batch upload
- [ ] Database schema: `pvoutput_daily_outputs`
- [ ] Settings UI — queue panel, Run Backfill button
- [ ] `GET /api/pvoutput/queue`, `POST /api/pvoutput/backfill`

### Phase 3 — Pull & History — 1–2 days

- [ ] `modules/pvoutput/pull.js` — `getsystem`, `getstatistic`, `getoutput`, `getstatus`
- [ ] Database schema: `pvoutput_history`, `pvoutput_system`, `pvoutput_stats`
- [ ] Gap detection algorithm
- [ ] `GET /api/pvoutput/history`, `GET /api/pvoutput/stats`
- [ ] Dashboard panel: lifetime stats, monthly chart data from PVOutput
- [ ] `POST /api/pvoutput/delete` — admin tool

### Phase 4 — Webhook & Alerts — 1 day

- [ ] `modules/pvoutput/webhook.js` — Express router, alert storage
- [ ] Database schema: `pvoutput_alerts`
- [ ] Notification registration / deregistration API calls
- [ ] Settings UI — webhook URL field, register/deregister buttons
- [ ] Dashboard notification tray integration
- [ ] `GET /api/pvoutput/alerts`, `POST /api/pvoutput/alerts/:id/ack`

### Phase 5 — Extended Data & Polish — 1 day

- [ ] Extended data (v7–v12) upload in push engine (donation mode gate)
- [ ] Donation mode detection via rate limit headers
- [ ] Battery state derivation from SOC + power direction
- [ ] Settings UI — extended data mapping dropdowns (shown only when donation_mode detected)
- [ ] README.md update — PVOutput section
- [ ] Rate limit warning banner in settings UI when remaining < 10
