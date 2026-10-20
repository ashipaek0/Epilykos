# Owned restore staging and native DATA scratch

This app change extends PR#182. Uploads remain limited to50MiB until the separate large-upload flow is ready.

## Ownership instead of age

Preparation publishes a private0700 DATA directory, a0600 ownership record and a kernel flock before starting a candidate writer. The parent and its SQLite child share the same open-file description. A killed parent cannot make the worker's still-live output eligible for deletion. On managed appliances, the child also retains the host maintenance lease through validation/migration, so host updates cannot overlap a surviving native writer.

Automatic cleanup runs at startup, hourly and before restore capacity admission. Startup/hourly cleanup uses the existing shared maintenance lock; an active cleanup coalesces further ticks and shutdown cancels further work. The collector yields while scanning and checks cancellation after acquiring a job lease. It never uses file age or PID guesses as ownership proof.

The collector recognizes only generated preparation directory names and the current ownership schema. It skips live leases, uncertain/missing lease identities, unrecognized contents, links and any job owned by the durable restore journal. An invalid or incomplete journal suspends all orphan decisions. In particular, an unexplained original.db is preserved. Scratch accepts only unaliased regular files with the vendored SQLite `etilqs_` prefix; unexpected names, directories, symlinks and hardlinks preserve the job. Cleanup validates scratch before removing any ownership metadata and never recursively deletes it. Other temporary-file namespaces are outside this change.

A generic deployment without usable kernel leases can still prepare and normally clean a restore. Its ownership record disables automatic orphan reaping. Managed appliances refuse preparation with503 if the lease cannot be obtained; they do not silently downgrade this guarantee. Linux uses util-linux flock, already required by the managed app maintenance contract. Other platforms do not run the automatic collector.

## Cleanup order and crash recovery

Large candidate files and known SQLite scratch disappear and are directory-synced before removing the lease pathname; the ownership record is removed last. Interrupted cleanup therefore retains either the metadata needed to resume, or a provably empty/metadata-only directory. Confirmed and rolled-back journal cleanup uses the same metadata ordering, while preserving the existing refusal of unknown files. The parent releases its own descriptor only after supervised children have exited and cleanup/handover has completed.

Cleanup failures preserve uncertain files and warn; they do not relabel an already confirmed restore as failed. Actual free space remains the authority for admission. A worker that survives only its parent continues holding its leases until it exits or the deployment supervisor terminates its process group/container. A full reboot/power loss releases kernel leases; startup can then reclaim the owned orphan. This does not add age-based forced worker termination.

## Native temporary files

The supervised migration process receives SQLITE_TMPDIR and TMPDIR pointing to its private DATA scratch directory before SQLite is loaded. Its staging and host lease descriptors are inherited explicitly. Monitoring includes visible scratch allocation plus actual DATA availability; unlinked-but-open SQLite temporary files still consume measured filesystem space. Periodic measurement is not a hard filesystem quota or a native-memory limit.

## Evidence

Tests cover active versus released jobs, a real parent SIGKILL with a surviving child lease, host maintenance exclusion after parent death, missing flock downgrade/refusal, incomplete journal refusal, unknown files, and startup cleanup waiting for maintenance. Death is injected after large-artifact, lease and ownership deletion, and during confirmed transaction metadata cleanup; recovery resumes without deleting uncertain rollback data.

A child opens a real SQLite temporary table with a small cache and spills native data to disk. Its /proc/self/fd paths prove the temporary file is under the DATA scratch directory and both lease descriptors are present. Integration tests exercise actual preparation, journal confirmation cleanup and reclaim-before-admission. These are Linux process/filesystem regressions, not physical Pi or power-cut acceptance and not a production-size restore benchmark.

Fresh review found and fixed one Important issue: recursive scratch removal could delete unknown nested contents. Four regressions reproduced the failure before the fix and now verify preservation for directories, symlinks, hardlinks and unknown regular files through metadata cleanup and orphan collection. No other review findings.
