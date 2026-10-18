# Restore runtime lifecycle

This app change builds on the preparation and durable swap in PRs #180 and #181. The storage journal can recover a file swap, but a running process also has timers, sockets, delayed responses, prepared statements and caches belonging to the previous SQLite connection.

## Handover and confirmation

The upload and snapshot HTTP routes now supply synchronous lifecycle hooks to the restore transaction. The application stops external REST, BMS, wired BMS, dongle, RS232 streaming, metric flush, PVOutput, notifications and update-check loops. It flushes combined-energy rows and metrics before closing the original connection. RS232 shutdown currently performs its close requests synchronously; port-close completion and network availability are not activation health requirements.

After opening the selected candidate, the transaction initializes the session schema, log settings, source engines, PVOutput and notifications, and checks the ordinary local health probe. All this runs before durable confirmation and deletion of the original. A local initialization failure stops candidate engines, restores the original, and reinitializes its runtime. Failure to resume the original returns 503; the HTTP process exits so its usual container/service supervisor can restart it and perform startup recovery. Uncertain storage is retained.

The activation section has no asynchronous yield. Device reachability and Internet services are deliberately excluded from local health. Background I/O started during initialization resumes after the transaction has either confirmed or rolled back.

## Delayed work and cached state

`databaseWork` gives each HTTP request and engine its own asynchronous generation. Closing a selected connection retires existing work. Database access from retired work throws `DB_RETIRED` (503), and retired metric submissions are dropped. Each scheduled main polling cycle starts a fresh scope. Candidate work is retired again on rollback. The restore request alone is refreshed for response/session finalization; the already-authorized session is explicitly saved into the selected database.

The server no longer keeps a connection variable that delayed request handlers could use after a swap. Captured SQLite handles in other engines are closed and cannot write into the replacement. PVOutput's global rate limiter additionally ignores retired updates, because its handle is replaced at initialization.

Connection-dependent state is rebuilt: PVOutput enabled/client/config/rate pools, notification rule/cooldown/source state and listeners, session and device-audit table readiness, dashboard response cache, and temporary debug-log timers. Session pruning obtains a fresh scope per run. Energy sanity baselines reload from restored persistence without erasing it; solar production/forecast/weather caches and source circuit breakers reset. Late forecast failures cannot repopulate restored-site caches. Retired main cycles stop after outstanding I/O instead of launching further source families. Bluetooth and wired BMS retain their in-flight exclusion during handover; new polling waits for those bounded operations to settle. Buffered combined-energy rows are cleared only after a successful transaction, so a failed pre-close flush can be retried.

## Verification

The focused tests exercise real SQLite files and the public restore function. Regressions cover pre-confirmation health and rollback, late original/candidate writes, PVOutput configuration and rate-limit isolation, notification state/listener replacement, auditing, dashboard cache, debug timers, sessions, failed combined-energy flush retry, energy baselines, solar cache invalidation, late forecast failures and BMS device-I/O exclusion. A separate child process runs the real Express server and authenticated HTTP upload route, verifies session access and restored settings, and injects an invalid candidate timezone to prove local startup failure restores the original.

These are process/software tests. They are not physical power-cut or Pi acceptance tests. Large DATA upload staging, owner-aware orphan cleanup, UI progress and compressed snapshots are subsequent changes. The existing 50 MiB HTTP upload limit is unchanged here. A normal deployment supervisor is needed to automatically restart a process after unrecoverable runtime handover.
