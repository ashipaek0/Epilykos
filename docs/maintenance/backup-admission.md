# Backup and daily-snapshot space admission

This follow-up integrates app PRs #175 (live DATA space), #176 (consistent
capture) and #177 (shared maintenance lock). Those are review dependencies;
all PRs target `dev`. This change enforces the S01 budget for SQLite captures.
Other maintenance types still need their own budgets before v1 is complete.

## Allocation model

Under the maintenance lock, after flushing pending metrics, read SQLite's
`page_count × page_size`. This includes committed pages represented in WAL;
the main database file size alone is not the estimate. A new private output is
budgeted for that size plus writer growth of **max(16 MiB, 1% rounded up to a
page)**. Reserve another **16 MiB plus one 100-page copy step** for output
journal/metadata and checking the next transfer. The destination must be the
new file inside the caller's private staging directory; overwriting an existing
large file is not part of this allocation model.

Admit only if application-usable free bytes (`statfs.bavail`) cover the entire
projected new output/allowances while leaving **max(10% DATA capacity, 1 GiB)**
on EpilykosOS. The OS context is its maintenance-lock opt-in or available host
socket, captured once per job. Ordinary Docker/native deployments budget the
necessary scratch allocation but do not inherit the OS-specific floor.
There is no compression assumption or deletion of retained snapshots to make a
job fit. Completed downloads already consume real filesystem blocks, so their
bytes are reflected in subsequent admissions. The shared maintenance lock
serializes captures; it is not held during immutable HTTP transfer.

During every incremental backup progress callback, reject database growth past
the admitted output size and recheck space. Recheck completed file size and
headroom before and after validation, and monitor free space once per second
while native SQLite validation runs. A pressure failure terminates and reaps
the validation process, removes only that job's staging and returns HTTP 507.
Daily-snapshot failures keep both previous snapshots and report their existing
failure notification. Unavailable/invalid filesystem measurements fail closed.

This is projected admission with monitored abort, not an ext4 quota. Ordinary
metric/log writes continue and can consume space between checks. The allowance
reduces that risk; it cannot prevent unrelated writers from exhausting DATA.
ENOSPC and other SQLite/I/O failures still take the normal capture cleanup path.
The active DB is not replaced by backup creation.

## Verification

`node --test test/backup-space-admission.test.js` uses real SQLite captures and
injects only filesystem capacity measurements. Cases cover inadequate initial
space, failed measurement, pressure after admission, readable success, growth
past the allocation cap, retention of both previous snapshots, percentage
headroom on a larger card, and pressure during a genuinely blocked native
validation read, plus generic backups on shared/sub-1-GiB filesystems. A fresh
review caught the initially global OS floor; a failing generic-deployment test
verified the compatibility fix. The initial three admission regressions failed before the
implementation. WAL-mode exclusive transactions do not block readers; the last
test deliberately switches only its disposable captured file to DELETE mode to
create the required native read contention.

## Still pending

- Host online/offline app, OS and boot-chain update budgets, restore/expanded
  upload budgets, and release enforcement of the cooperating app capability.
- Owner-aware cleanup after process/power failure; normal failed jobs clean up,
  but no age-based deletion of potentially active files is introduced.
- Crash-durable snapshot publication/pruning and gzip/restore transactions.
- Real ~5.9 GB Pi 3B memory, page-step latency and ENOSPC/power-cut evidence.
  The CI-sized database is not that hardware acceptance.
