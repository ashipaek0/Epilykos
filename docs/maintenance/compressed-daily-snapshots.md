# Compressed daily snapshots (S05 publisher/scheduler)

Base: gzip restore PR185 at695bf67. This branch targets dev and retains the prerequisite maintenance/restore stack. No merge, release or stable publication is part of this work. Gzip restore was delivered separately; this slice supplies daily publication, discovery, retention, scheduling and visible status.

## Capture and verification

A single shared maintenance owner captures the live SQLite database through the existing incremental online backup, including committed WAL data. Native quick_check validates the immutable capture before compression. Snapshot ownership and host descriptors are inherited by the native checker; parent death does not free exclusion while it still reads the private file. Raw capture, gzip and SQLite scratch use a0700 owned DATA job; gzip/raw files are0600. Shutdown signals cancellation and awaits capture/streams/native workers before DB closure.

Capture admission reserves the bounded raw size/growth allowance, compressed output allowance, normal scratch and appliance maintenance floor. Existing retained files already consume actual statfs free space; their deletion is never credited. Gzip output is capped at raw+1%+1MiB, an enforced conservative allocation policy rather than a zlib size theorem. While writing, fresh checks reserve remaining output plus scratch. Unrelated writers can still exhaust space between checks; this is not a filesystem quota.

Compression computes raw SHA256 while streaming. Verification streams gunzip into a hash/discard sink and checks CRC/end-of-stream, exact raw length, SHA256, and unchanged validated-source identity/size/mtime. No whole-file buffer or second expanded verification file is used. Compressed data is never published merely because compression returned successfully.

## Publication and retention

New names encode a20digit monotonic generation plus wall-clock stamp and UUID. Generation determines order across clock reversals; new generations sort above pre-upgrade raw snapshots. Publication links the verified/fsynced staged gzip to a new name with no overwrite, fsyncs the snapshot directory, unlinks its staging alias, then prunes older managed successes and fsyncs directory changes. No pruning is authorized before a verified durable replacement exists. A failed prune can retain extra copies; preserving recoverable data takes priority over forcing the count to two.

The snapshot staging role alone permits its gzip artifact to have exactly two hardlinks during publication. Cleanup removes only its private namespace entry, never a published path. This handles death between link and unlink without leaking large owned staging forever. Raw-file aliases, extra hardlinks, unknown contents and uncertain ownership remain preserved by the existing conservative collector. Native-child-held jobs remain ineligible until their inherited lease closes.

Legacy .db files remain listed/restorable through native preparation, and new managed .db.gz files use the validated bounded expansion added by PR185. Pruning recognizes only managed legacy/new names and keeps the two newest managed successes. Unknown .db files remain restorable but are neither pruned nor accepted as substitutes for managed retention. Symlinks/nonregular files and unsupported aliases are excluded. Old pre-upgrade staging/download orphan namespaces are not recursively swept by this change.

## Scheduler and warnings

One capture can be in flight. Missed days coalesce into one attempt after local schema health and a nonwaiting maintenance lease become available. Internet, inverters and Bluetooth are not health prerequisites. Minute ticks create no work when the latest managed snapshot is current. A future-dated latest snapshot causes one corrective generation rather than suppressing daily backups indefinitely.

A bounded/fsynced DATA retry state is persisted before each actual capture. Maximum4actual attempts per24hour retry window; delays are5minutes,30minutes,2hours, then the remaining window. Busy/unhealthy deferral consumes no attempts. Permanent lock errors are reported rather than disguised as busy. Deadlines are monotonic in-process; normal restarts recover remaining delay/count from persisted wall timestamps. Backwards clock detection rebases the window while retaining count. Elapsed time while powered off cannot be proven without a trustworthy clock. Invalid/uncertain retry state is preserved; automatic capture pauses with a visible error instead of overwriting unknown data or running without retry bounds. Manual backup/restore and normal monitoring remain available.

Failed captures emit backup.snapshot_failed with a15minute warning throttle. Missing/overdue/future-dated snapshots emit backup.snapshot_overdue at most once perday across normal restarts; overdue means none, a timestamp ahead of the clock, or age beyond25hours. Settings shows phase, last error, next retry and compressed/legacy format. Navigation or Refresh snapshots retrieves current status. Existing snapshot array API remains compatible; authenticated GET /api/snapshots/status adds status without paths. Status/retry metadata never selects databases or authorizes pruning.

## Automated evidence

Real native/process/HTTP tests cover committed WAL capture; gzip/hash validation; corrupt compression and admission failure without pruning; no-clobber collision; directory fsync failure preserving old copies; backwards generation ordering; unknown-file preservation; SIGKILL at captured/linked/durable/detached/pruned phases; readable surviving snapshots and reclaimed private aliases; cancellation during gzip writes; prune failure preserving extra durable copies; a native checker retaining both job/host leases after parent SIGKILL; gzip and legacy restore through the actual validated transaction; health/busy deferrals; coalescing, fractional real monotonic clocks, durable retry counts and clock reversal/restart; cancellation/shutdown and uncertain retry-state preservation.

Full npm test, final read-only review and CI results are recorded in the PR/execution ledger. These host tests do not establish physical Pi power-cut durability, production-size memory/disk-full performance, or recovery against hostile privileged filesystem modification. Those acceptance requirements remain separate, as does the real released app digest/pin required by the OS compatibility gate.

Final review found one Important preservation defect: an unrecognized small retry temporary file was deleted. The fix recognizes valid schema state before reclaiming that reserved temporary sibling, and preserves unknown/partial/aliased/oversized files with a visible failure. Unknown text and partial JSON regressions failed before the fix and passed afterward; recognizable interrupted state remains recoverable. Focused final ownership/publisher/scheduler checks55/55 passed. No deferred minor findings.
