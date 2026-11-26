# InfluxDB: using a database the user already has

For people who already keep their readings in InfluxDB (often through Home Assistant's InfluxDB integration). Epilykos
reads each mapped metric's history from it, keeps writing new readings to it from the moment it was connected, and fills
gaps from it after a restart. Settings → InfluxDB. User guide: the wiki's Settings → InfluxDB page.

Supported: InfluxDB 2.x (Flux) and 1.x (InfluxQL). Not 3.x.

## Where the data lives

Epilykos keeps its own SQLite database as the store every chart, report and total reads. The history is **copied** in at
5-minute detail rather than queried live: every reader in Epilykos is synchronous over SQLite, and a copy means imported
days work everywhere at once (charts, hourly energy, daily totals, reports, savings) with no change to them. InfluxDB stays
the user's system of record: everything new is written back to it.

## Modules

| File | What it does |
| --- | --- |
| `modules/influx/client.js` | One interface over 1.x and 2.x: `test`, `measurements`, `fieldKeys`, `tagKeys`, `tagValues`, `first`, `buckets` (5-minute mean/min/max/count computed by the server), `write`. Requests go through `safeFetch` with private addresses allowed; loopback, link-local and metadata addresses stay refused; redirects are not followed. |
| `modules/influx/queries.js` | The InfluxQL and Flux text. Every user-chosen name is quoted and escaped (Flux `${` included). |
| `modules/influx/lineProtocol.js` | Line protocol with the reference escaping; a point that cannot be written safely is refused. |
| `modules/influx/settings.js` | `influx_connection` (secrets encrypted: `SECRET_FIELDS.influx_connection`), `influx_mapping`, `influx_write`; the Home Assistant layout suggestions. |
| `modules/historicalStore.js` | `storeHistoricalBatch`: older than 30 days into `metrics_5m`, newer into `metrics`; the dashboard's own readings win per metric and 5-minute bucket. |
| `modules/influx/importer.js` | The import: a week per request, progress saved per week (`influx_state.import`), retries, skip a metric that cannot be read. |
| `modules/influx/roleHistory.js` | After an import, the role history (`history_5m` older, `history` newer as five rows a minute apart) so every reader counts each imported 5 minutes in full. |
| `modules/influx/writer.js` | New readings, read back from `metrics` in `(timestamp, metric)` order from a saved position (`influx_state.write`): nothing is lost while InfluxDB is down or Epilykos restarts. |
| `modules/influx/service.js` | One per process: the writer, the import's resume, and the filling of gaps (a minute after startup, then daily; `influx_state.gap`, `syncedThrough`). Paused around a restore by `restoreLifecycle`. |
| `routes/influx.js` | `/api/influx`, signed in. |

## What is written

One measurement (default `epilykos`), tag `metric=<Epilykos metric name>`, field `value` (float), second precision. Mapped
metrics only, or every numeric reading. Readings from before `influx_state.connectedAt` are never written.

## Rules that keep it safe

- The dashboard's own readings always win; an import or fill only adds where Epilykos has nothing for that 5 minutes.
  Running an import again stores nothing new.
- An empty token or password in a form keeps the saved one only for the same server, user and database or bucket.
- The `influx_*` config keys cannot be written through `/api/settings` (`modules/protectedConfig.js`).
- A restore retires work in flight (`databaseWork`): neither the importer nor the writer writes its position into the
  restored database.

## Tests

`test/historical-store`, `influx-client`, `influx-settings`, `influx-import`, `influx-writer`, `influx-gaps` (`.test.js`)
and `test/security/06-influx.js` in the release attack suite. The queries were also checked against real InfluxDB 1.8 and
2.7 servers.
