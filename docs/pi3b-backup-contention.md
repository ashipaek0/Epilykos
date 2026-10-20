# Pi 3B backup contention

A hardware acceptance run on a Raspberry Pi 3B running app `1.0.1-dev+0e29bec` restored a 1,091,293,184-byte synthetic SQLite database successfully in 480.977 seconds. A backup requested immediately afterward overlapped an automatic snapshot and returned:

```text
HTTP 500
Backup failed: Maintenance lock 'maintenance' timed out after 5000ms
```

The restore had already reached `selected`. This response indicated maintenance contention, not database corruption. The isolated test used WAL/FULL, the installed image, a 640 MiB container limit and a 64 MiB temporary filesystem. No production database was restored.

The correction identifies both in-process and shared-file lease contention as `LOCK_BUSY`. Backup returns HTTP 503 and tells the user to wait until the current snapshot, backup or restore finishes. It retains HTTP 507 for insufficient storage and HTTP 500 for unexpected failures. It does not queue an unbounded backup or relax the maintenance lock.

Regression tests hold each actual lock backend through the acquisition timeout, check the busy response, then release the lock and verify two downloads can still start and contain valid SQLite data. Both tests returned 500 before the fix. The lock timeout test also checks its machine-readable error code.

Remaining hardware checks and the final acceptance verdict are tracked separately. These observations do not establish physical power-cut recovery, failed bootloader recovery, live inverter interoperability or production-size database performance. The response correction must be installed before claiming it is deployed on the Pi.
