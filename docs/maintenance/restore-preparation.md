# Offline restore migration preparation

This S04 preparation slice builds on #179. It targets `dev` and leaves the
50 MiB upload limit unchanged. Durable activation/recovery and the complete
service lifecycle are the next transaction slice; this PR does not claim that
the legacy replacement is power-cut safe.

## What changes

Basic preflight checks cannot predict every initializer failure. For example,
`history(unrelated TEXT)` passes the three-core-table check but fails when the
initializer creates its timestamp index. A CHECK constraint on config can also
reject required initialization writes after the old restore has closed the live
handle. Two real-SQLite regressions demonstrated those late failures before this
change.

After existing preflight and admission, create a unique 0700 `.restore-*` directory
beside the live DB on DATA. A child process copies only the standalone input into
it, runs the actual `initializeDatabase` against that copy, and checks the result
with rolled-back core config/numeric/text write probes and SQLite `quick_check`.
The probes detect write constraints the initializer does not exercise and leave
no synthetic rows. It uses the same migrations/defaults as real startup,
including optional tables and legacy config conversion, without closing the
parent's database or starting MQTT/polling. Trusted schema is disabled before
initialization. The initializer's new file-path option never falls back to an
in-memory DB if its destination cannot be created.

The child uses FULL synchronous mode, converts its private candidate to DELETE
journal mode, closes SQLite and fsyncs the resulting standalone file. Source
bytes remain unchanged. The parent checks source inode/device/length/mtime again
and re-admits replacement using the **actual migrated size**. The old replacement
then consumes the prepared candidate, not the original upload. Activation opens
the prepared DB without replaying migrations/default writes a second time.

The existing SQLite process supervisor now serves validation and preparation:
32 MiB V8 heap, 30-minute deadline, kill/reap before cleanup, and a one-second
capacity check. The preparation also bounds observed candidate/WAL/SHM/journal
scratch to twice input bytes plus 32 MiB. The existing projected restore budget
and OS-only DATA floor apply; invalid/failed preparation returns HTTP 400 and
storage pressure/ENOSPC/SQLITE_FULL returns 507 while the live handle remains
open. File logging is disabled in the child. Existing encryption-key access is
preserved for actual legacy secret migration; the database itself is isolated.
Missing encryption-key creation is now atomic across processes: write/fsync a
private same-directory temporary key, publish by exclusive hard link, and read
the winning key if another creator wins. No creator overwrites the winner or
exposes an empty key file. Before returning new ciphertext on POSIX, sync the
key directory so a concurrent publisher's directory entry is durable too.
Windows retains atomic key selection without the unavailable directory-fsync
guarantee. Filesystems lacking hard links fail closed instead of falling back
to key overwrite; supported EpilykosOS DATA is ext4.

Successful/failed jobs remove their own staging after the child exits. A cleanup
I/O failure is logged without changing a successful replacement into a false
"original restored" response. It may leave an orphan consuming measured space;
owner-aware startup orphan cleanup remains pending. No age-based deletion of
potentially active jobs is introduced here.

## Verification and limits

`test/restore-preparation.test.js` exercises real optional-table and CHECK
constraint migration failures before live closure, migrated legacy-copy
readability/input immutability/event-loop progress, private directory permissions,
pressure during preparation, cancellation of a long native trigger during real
initialization, staging-allocation ENOSPC, preparation exactly once during
activation, text-telemetry constraints, and cleanup failure after successful
replacement. `test/encryption-key-publication.test.js` deterministically lets a
real competing process publish between the parent's missing-key read and
publication, then decrypts both secrets with the winning key. The original
two late-migration regressions, write-constraint/cleanup-result regressions and
all three review findings failed before their fixes. Existing backup/preflight
cases exercise the shared supervisor.

This rehearses what the current initializer actually does. It does not prove
every future telemetry write or all arbitrary trigger/data semantics are valid,
nor resolve encrypted backups imported without their matching encryption key.
Key creation may leave a synced temporary file if the process dies before
unlinking it; it cannot replace an already published key.
The 32 MiB V8 setting is not a limit on SQLite native memory. Capacity checks
are projected admission/monitored abort, not quotas: a native operation can grow
between checks. Physical large-database, SD ENOSPC and power-cut evidence is
still pending. The old checkpoint/raw-copy activation remains unsafe until the
durable journal/swap slice replaces it.
