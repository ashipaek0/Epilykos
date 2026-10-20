# Owned backup downloads and safe orphan cleanup

Base: compressed snapshot PR186 at0a19bd7. Separate app branch/PR targeting dev, authoredashipaek0. No merge/release/publication. This implements new download-job ownership; it does not infer ownership of legacy unowned staging.

## Lifecycle

Before native capture, the request acquires existing shared maintenance, reaps proven inactive owned jobs, then creates a private0700 DATA `.backup-owned-XXXXXX` job. Owner metadata and the job lock are0600; completed SQLite output is0600. Native validation uses DATA scratch and inherits both private job and host-maintenance descriptors. Cancellation/disconnect awaits native termination before any cleanup or transfer handoff.

After consistent SQLite capture/validation, shared maintenance is released. The immutable download retains its private kernel job lease until its response callback completes or disconnects. Slow clients therefore cannot block restore/host maintenance for the entire transfer. The existing maximum of two retained downloads remains enforced; transferred/captured bytes continue counting in actual DATA allocation admission.

Completion/error cleanup uses the existing closed-role collector and never recursively deletes the download directory. Allowed artifacts are energy.db and its SQLite sidecars, owner/lock metadata and recognized SQLite scratch. Unexpected regular files, directories, symlinks or hardlinks preserve the entire job and emit a warning. The snapshot-specific two-hardlink publication exception does not apply to downloads. Cleanup remains idempotent and releases the download slot even when files must be preserved; those bytes still consume measured DATA space.

## Orphan recovery

On Linux/flock, startup/hourly collection and pre-maintenance/pre-download reaping now recognize the download role. Automatic deletion requires recognized job ownership, known unaliased contents and an obtainable private kernel lease. Metadata/lock identities are rechecked after asynchronous acquisition. Parent death during native validation leaves both descriptors held by the worker; collection remains excluded until it exits. Parent death during pure HTTP transfer closes process-owned readers/leases, permitting reaping of only the proven inactive jobs.

No PID/age heuristic is added. Pre-upgrade .backup-/.snapshot- directories, jobs without recognizable ownership, unknown contents, unsupported aliases and uncertain restore-journal state remain preserved. These may continue using DATA until inspected. Generic non-Linux/no-flock deployments retain normal backup and request-owned cleanup support; uncertain orphan collection stays disabled. Managed appliances still require kernel ownership rather than silently downgrading.

## Evidence

Six new download regressions originally failed: missing ownership namespace/lease, recursive deletion of unknown regular/directory/link contents, and missing pre-admission role reaping. They pass with the owned path. Tests exercise a completed capture retaining its private lease while shared maintenance is available; live collector exclusion; unknown contents and raw hardlinks preserved on completion and later reaping; proven orphan removed before statfs admission; legacy unowned files retained.

Real process tests block the native validator on SQLite, kill its parent and verify both host/private exclusion until worker termination. A separate disconnect test aborts while validation is blocked, observes that the worker is reaped before job cleanup and confirms that no download was handed off. Real HTTP tests pause two32MiB responses, verify the third request receives503 and shared maintenance remains available, kill the serving process, then reclaim only the two known jobs while preserving legacy/unowned paths. Existing WAL consistency, monitoring-yield, admission/floor, overlap, stream-disconnect and restore/snapshot regressions remain covered.

Full-suite, final review and CI results are recorded in the PR and execution ledger. This is host native/process/HTTP evidence, not physical power-cut or production-sized Pi memory/performance acceptance. Privileged concurrent filesystem substitution remains outside the existing caller-owned DATA model. The prerequisite app stack and genuine release/digest pin are still required by the OS gate.
