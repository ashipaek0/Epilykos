# Durable restore file activation and startup recovery

This storage-protocol slice builds on #180 and targets `dev`. It removes the
legacy in-place DB overwrite and adds recovery before ordinary initialization.
Runtime producer retirement/cached-engine rebinding remains the next lifecycle
slice; the upload limit stays 50 MiB until that is verified. It is not a full
S04 or physical power-cut acceptance claim.

## Protocol

Preparation still copies/migrates/checks its private DATA candidate while the
original stays open. Activation has no await: all main app SQLite calls use the
same JS thread/connection; the maintenance lease excludes the app DB checker,
retention and host update jobs. Flush queued metrics, require SQLite to convert
the original from WAL to DELETE journal mode, then close it. A busy reader
returns409 before closing or moving that handle. A failed flush retains the
queued batch for retry instead of losing it. MQTT message listeners are retired
before reconnecting against the accepted DB.

The storage protocol requires closed, standalone, regular single-link files on
the same filesystem. Fsync both complete files and their directories. Persist a
0600, bounded version1 `.restore-transaction.json` via a synced temporary file,
atomic rename and DATA directory sync. It records only `pending/confirmed`, the
strict private `.restore-XXXXXX` basename and original/candidate inode identities.
All database basenames are fixed in code; journal content cannot select other
paths or execute hooks.

With pending intent durable, rename the original into its private job directory,
sync both directories, rename the prepared file to the live path, and sync both
again. Open the candidate without rerunning initialization, check local DB use,
checkpoint its WAL with FULL synchronous mode, and only then durably confirm the
journal. Cleanup removes the old file after confirmation; a cleanup failure
leaves a confirmed journal for startup retry and does not undo the result.
Normal runtime synchronous policy is restored before confirmation.

Before initialization opens SQLite, recovery interprets the journal:

- Pending: recover the original from its job, or recognize its recorded inode
  already at the live path. Candidate-owned sidecars are removed only while
  reverting the closed candidate with its recorded inode. The original-already-
  live and live-absent branches require no sidecars at that path; uncertain
  sidecars are preserved with the journal and refused. Never attach a candidate
  or unowned WAL to the original.
- Confirmed: retain the new database **and its normal crash-recovery WAL**;
  finish only old-file/staging cleanup.
- Missing/malformed journal state, wrong inode, unexpected original sidecars,
  symlink/nonregular files and unknown job contents fail closed before startup
  can manufacture an empty DB. Existing complete files remain for diagnosis.

Recovery is idempotent, including a second interruption during rollback or
cleanup. Preparation cleanup cannot recursively delete a journal-owned job,
which can contain the only complete original. A confirmation directory-sync
failure re-establishes durable pending intent before attempting rollback. If
rollback itself cannot complete, preserve the journal/files, return503 and do
not claim that the original was restored. Ordinary boot/startup retries recovery.

## Verification

`test/restore-transaction.test.js` uses the public restore function. The initial
kill-during-first-live-mutation case left a partial active DB and failed startup
before this change; the busy-reader case also proceeded incorrectly before its
fix. Both now pass. Other cases verify telemetry-flush failure retains its batch
and candidate health failure recovers the complete original.

`test/restore-swap-recovery.test.js` uses actual closed SQLite files, kills a
separate process at18 transition points (journal preparation/publication, both
renames, candidate WAL writes, confirmation, cleanup and rollback interrupted a
second time), then checks integrity and exact original/candidate identity. It
also covers malformed/traversing journals, missing-original startup refusal,
unknown active inodes, original sidecars and confirmation-fsync failure followed
by rollback. Fresh review identified two missing sidecar-ownership checks; both
were reproduced by failing tests (including an actual unrelated SQLite WAL)
before tightening the pending recovery branches. These tests observe process
death with the kernel still running;
they do not emulate lost filesystem cache or a faulty SD controller.

## Boundaries and next work

- Runtime quiescence is currently the synchronous single-connection activation
  boundary. Retired asynchronous source responses, cached PVOutput/server
  handles and notification state still need explicit lifecycle integration and
  health participation before S04 is complete or large uploads are enabled.
- No age-based orphan deletion is added. Pre-journal preparation/temp files can
  remain after death; owner-aware cleanup belongs with the next staging work.
- Filesystem/fsync durability is designed for Linux ext4 DATA. Physical SD
  power-loss/ENOSPC and production-size checkpoint/outage latency still require
  acceptance evidence. A checkpoint runs synchronously in the declared outage
  boundary; preparation and full-file scans stay in child processes.
- A permanently failing filesystem or an impossible/corrupted recovery state
  remains unavailable for diagnosis. This protocol does not auto-format DATA,
  guess between unrelated files or import old unjournaled `.bak` files.

SQLite documents why the DB and its journals must remain paired and why open
files must not be renamed in [How To Corrupt An SQLite Database](https://www.sqlite.org/howtocorrupt.html).
The protocol closes owned handles before movement and uses SQLite's own
journal-mode transition instead of treating a busy checkpoint as success.
