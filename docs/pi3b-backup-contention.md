# Pi 3B maintenance findings

A hardware acceptance run on a Raspberry Pi 3B running app `1.0.1-dev+0e29bec` restored a 1,091,293,184-byte synthetic SQLite database successfully in 480.977 seconds. A backup requested immediately afterward overlapped an automatic snapshot and returned:

```text
HTTP 500
Backup failed: Maintenance lock 'maintenance' timed out after 5000ms
```

The restore had already reached `selected`. This response indicated maintenance contention, not database corruption. The isolated test used WAL/FULL, the installed image, a 640 MiB container limit and a 64 MiB temporary filesystem. No production database was restored.

The correction identifies both in-process and shared-file lease contention as `LOCK_BUSY`. Backup returns HTTP 503 and tells the user to wait until the current snapshot, backup or restore finishes. It retains HTTP 507 for insufficient storage and HTTP 500 for unexpected failures. It does not queue an unbounded backup or relax the maintenance lock.

Regression tests hold each actual lock backend through the acquisition timeout, check the busy response, then release the lock and verify two downloads can still start and contain valid SQLite data. Both tests returned 500 before the fix. The lock timeout test also checks its machine-readable error code.

Remaining hardware checks and the final acceptance verdict are tracked separately. These observations do not establish physical power-cut recovery, failed bootloader recovery, live inverter interoperability or production-size database performance. The response correction must be installed before claiming it is deployed on the Pi.

## Database-check shutdown

The same hardware run's final fixture stop reached its 30-second force-kill deadline after a recovered app had scheduled an unclean-shutdown database check. The exact shutdown phase was not logged. Inspection identified a reproducible cancellation defect: `dbCheck` wrapped synchronous native `quick_check` in a worker thread, and `Worker.terminate()` could not interrupt native SQLite work.

A Linux regression holds an exclusive SQLite lock, verifies the checker opened the database, then requests shutdown. The previous code misses the one-second stop bound. The correction uses the existing supervised SQLite child-process runner, passes the shared maintenance lease descriptor to the child and reaps it before releasing maintenance. Cancellation preserves the prior real check result; actual corruption and other check failures remain reported.

The bounded-cancellation regression also passes on the Pi's ARM64 runtime with only the candidate checker modules mounted over the installed image. This is component validation, not deployment of a new application image; the normal dashboard keeps running unchanged.
