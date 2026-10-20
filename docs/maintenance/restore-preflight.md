# Restore candidate validation and space admission

This slice adds preflight to both uploaded database restores and retained
snapshot restores. It depends on app PR #178, which integrates #175, #176 and
#177. All target `dev`; merge the dependencies first. It is a partial S01/S04
delivery, not the crash-safe restore transaction or expanded-upload feature.

## Behavior and evidence

Before creating the rollback copy, closing the live database or stopping MQTT,
the existing maintenance lease now covers these checks:

1. Require a separate regular file, at least 512 bytes, with no symlink, shared
   live-database inode, WAL, SHM or journal sidecar. Inputs must be self-contained.
2. Admit scratch space using unprivileged filesystem `bavail`. Reserve the
   current live SQLite `page_count × page_size`, twice the candidate file size
   and 32 MiB. This conservatively includes a new rollback copy, restored file,
   a migration-WAL allowance and small overhead. The staged input is already
   charged to actual free space; never credit truncation of the live database
   or deletion of existing backups. Recompute the live page count on every
   check, including after validation, to account for monitoring writes.
3. On EpilykosOS, also leave max(10% of DATA capacity, 1 GiB) free. OS context
   means the maintenance-lock environment opt-in or available host API. Generic
   deployments reserve scratch without inheriting the OS floor. Unavailable
   measurements and insufficient headroom fail closed with HTTP 507.
4. Open the candidate read-only in a separate Node process, disable trusted
   schema and enable query-only, then run SQLite `quick_check` across the file.
   Require ordinary `config`, `metrics` and `latest_metrics` tables with their
   consumed core columns, matching SQLite type affinities and exact primary
   keys. Affinity follows SQLite's [ordered declared-type rules](https://www.sqlite.org/datatype3.html#determination_of_column_affinity), so equivalent spellings such as
   `VARCHAR` and `DOUBLE PRECISION` remain supported. Missing additive legacy
   columns remain permitted; initialization supplies them after acceptance.
5. Require `user_version = 0`, the format actually emitted by this repository.
   Nonzero versions are unsupported, not evidence of compatibility. The
   currently unused `schema_migrations` table is not a format registry.
6. Check the candidate inode, device, size and mtime again, and require its
   physical length to match SQLite's page count. Recheck capacity while the
   child runs (once per second) and after it exits. Invalid candidates return
   HTTP 400 without rebinding or changing the open live database.

The validator has a 30-minute deadline, a 32 MiB V8 heap setting, and kill/reap
on cancellation or pressure. The process boundary is necessary because a
native SQLite scan or busy handler cannot be interrupted by terminating a Node
worker. The V8 heap setting does **not** bound SQLite native memory. Read-only
SQLite may create empty WAL/SHM files for a standalone WAL-mode source; checker
exit precedes removal of those sidecars. Pre-existing sidecars are rejected
without deletion. Callers provide their own upload files or immutable snapshots;
this fingerprint check is not protection against a privileged concurrent writer.

`test/restore-preflight.test.js` uses real SQLite files and the public restore
path for rejection cases. It covers incompatible columns and primary keys,
corruption in an otherwise unused table, unknown format versions, insufficient
headroom, live growth during validation, readable legacy input, sidecar and
symlink rejection, kill/reap during a blocked native read, standalone WAL-mode
cleanup, and successful legacy restore with additive migrations. Only capacity
measurements are replaced in the space tests. The column, version and capacity
regressions failed before preflight; the unused-table corruption was previously
accepted. A separate failing growth regression exposed a stale initial live-size
estimate before the budget was changed to recalculate it.

Independent review also reproduced an integer `config` primary key passing
preflight, then failing initialization after closing the live handle. The new
affinity regression failed before its fix and passed afterward; an equivalent
type-name case guards against rejecting supported aliases. The final focused
suite contains 13 cases.

## Limits and remaining work

- `quick_check` checks database structure; it is not `integrity_check` and does
  not prove index contents agree with tables. Core column/key checks do not
   rehearse every migration or prove all optional historical tables, arbitrary
   CHECK/NOT NULL/trigger constraints and their contents are compatible. A
   declared schema policy and offline migration
  rehearsal belong with S04.
- This is projected admission with monitored abort, not a quota or a proven
  upper bound on every future migration. Other writers can consume DATA
  between checks. The migration allowance must be revised when migration
  allocation changes; ENOSPC after preflight remains a replacement failure.
- The legacy replacement still checkpoints/copies the live DB, closes it,
  copies the candidate over it and tries rollback on failure. It is **not
  power-cut safe**, and checkpoint contention, WAL preservation, durable
  activation/recovery and complete service quiescence remain S04 work. Do not
  interpret a successful preflight as a safe activation guarantee.
- The 50 MiB upload limit and existing upload location remain unchanged.
  DATA streaming and expanded restore limits are pending the safe transaction.
- No production-size (~5.9 GB), physical Pi 3B, power-cut or native-memory
  acceptance claim is made by these CI-sized tests.
