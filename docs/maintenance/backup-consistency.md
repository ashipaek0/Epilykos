# Online backup consistency and download lifecycle

This change fixes backup capture and concurrent HTTP downloads. It is a slice of
EpilykosOS v1 S02, not completion of the storage/restore workstream.

## Before and after

The previous capture ran `wal_checkpoint(TRUNCATE)`, ignored a busy checkpoint,
and copied only the main database synchronously. A reader can keep committed
changes in WAL, so the copy can miss data. `SELECT 1` does not inspect database
pages. Every download also used `energy.db.backup-tmp`; completing one transfer
could delete a different transfer's file.

Capture now uses `getDb().backup(destination)`. SQLite includes committed WAL data
and provides a consistent database without changing the live journal mode.
Better-sqlite3 copies 100 pages per event-loop turn by default. Using the normal
writer connection avoids the documented backup restarts caused by writes through
a different connection. Polling can continue during capture; latency on a slow
card still requires measurement.

A separate Node process runs full SQLite `quick_check` on the captured file before it is offered
for download. Validation has a 30-minute deadline. Client cancellation aborts
capture/validation and waits for that process to exit before removing staging.
Every download has a private mode-0700 directory under the database's DATA
parent. Express streams its immutable file. The maintenance lock covers capture
and validation; each HTTP callback owns its own cleanup after that lock releases.
At most two download jobs (including captures and waiting jobs) are retained in
one app process; further requests return 503. Failed transfers do not update the
successful-backup reminder timestamp.

Daily snapshots also await capture and validation in a private directory, then
rename the completed file into the snapshot list before pruning. They keep their
existing uncompressed format and retention of two files.

## Evidence and review

`node --test test/backup-downloads.test.js test/sqlite-snapshot.test.js` exercises
real SQLite files, a reader blocking WAL checkpointing, overlapping download
lifetimes, transactions written during capture, an 8 MiB payload, a real Express
HTTP disconnect, cancellation, bounded download count, corrupt content rejection,
snapshot publication/retention, and cancellation while a native SQLite read is blocked.
The initial worker implementation failed the last regression: abort waited 4.8
seconds for SQLite. Process termination passed it; worker termination cannot
interrupt synchronous native SQLite code. The original five regression cases failed
against the previous implementation and passed with this change.

Relevant upstream specifications:

- [SQLite online backup API](https://www.sqlite.org/backup.html): consistent live
  database capture and incremental copy semantics.
- [better-sqlite3 backup API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise):
  asynchronous backup, page batching and effects of concurrent writes. Verified
  against installed better-sqlite3 13.0.3 as well as its documentation.
- [SQLite quick_check](https://www.sqlite.org/pragma.html#pragma_quick_check):
  structural verification; this is not a complete semantic/schema audit.

## Acceptance still pending

- Shared host/app maintenance coordination and byte reservations/headroom checks.
  The two-job cap is not disk admission: two large files may still exceed free
  space. Disk errors fail capture and clean its staging without replacing the
  active DB. A process/power failure can leave private staging that needs the
  planned owner-aware startup cleanup; there is no unsafe age-based deletion.
- Production-size (~5.9 GB) Pi 3B memory, I/O latency, disk-full and interruption
  evidence. The small CI fixture establishes behavior, not hardware performance.
- Full off-event-loop capture: the current API yields between bounded page
  batches, but each native batch performs synchronous I/O on the writer thread.
- Crash-durable snapshot publication/pruning, gzip compression and validated
  legacy/gzip restore are S04/S05 work. No power-cut safety claim is made here.
- Restore still uses its old replacement path and the upload limit remains
  50 MiB. This PR does not make large restore safe or enable it.
