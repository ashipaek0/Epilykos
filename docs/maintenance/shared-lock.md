# Shared EpilykosOS / app maintenance lock

This is the mutual-exclusion slice of v1 S01. It does not reserve disk bytes.

The paired OS sets `EPILYKOS_MAINTENANCE_LOCK=/app/data/.maintenance.lock` when
starting the app. The bind mount maps that inode to the host's
`/data/epilykos/app-data/.maintenance.lock`. Existing app backup, restore,
snapshot, integrity-check and retention jobs use the `maintenance` lock label;
that label now obtains both the existing FIFO in-process lock and this kernel
lock. Normal deployments without the variable keep their existing behavior.

The host updater takes a nonblocking exclusive lock before writing job state,
pulling a candidate or restarting the app. Busy maintenance returns an error
without beginning an update. It holds the descriptor through health checks,
promotion or rollback and releases it even if worker preparation/cleanup fails.
App waits use the existing five-second total acquisition budget. No public host
API accepts a lock path or runs a shell command.

Node opens a regular DATA file without following symlinks and maps its descriptor
to fd 3 of the installed util-linux `flock` executable. The lock belongs to the
shared open file description, so it remains owned by Node after that helper
exits. Closing the descriptor or terminating the owner releases it. The host
uses Python's `fcntl.flock` on the same inode, with permissions allowing the
fixed container gid 1000. Neither implementation deletes the lock file. There
are no expiring leases or stale PID-file overrides.

The descriptor must not be inherited by update subprocesses; Python opens it
with `O_CLOEXEC`. Node's helpers receive only their explicitly mapped descriptor.
Symlinks/FIFOs are rejected; the root host also rejects hard-linked files before
changing ownership/mode. An invalid path or missing helper fails maintenance
closed. The app image explicitly installs util-linux and advertises
`io.epilykos.maintenance-lock=flock-v1`.

## Tests

The Node regression tests use real independent Python/Node processes to prove
exclusion in both directions, timeout/queue recovery, release on process death,
inode preservation and symlink rejection. The OS tests exercise real flock
contention plus update pull/health/rollback with subprocess stand-ins that reject
an unprotected call. A worker metadata-read fault verifies release on failure.
The executed `epilykos-run` argument fixture verifies the environment wiring.

[Linux flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html)
explain descriptor ownership and automatic release on last close. These tests
also verify the assumptions on Linux rather than relying on process IDs.

## Compatibility and pending work

Both app and OS changes are required for cross-process exclusion. An older app
ignores the new environment variable; a newer app on an older OS does not opt in.
The image label is a capability declaration, not yet an enforced release gate.
Before v1 is declared ready, its pinned baseline and candidate validation must
require the cooperating app capability and test the paired release. Existing
legacy deployments are not silently claimed to be coordinated.

Byte budgets, actual usable-space admission/rechecks, bounded expansion/upload,
owner-aware orphan cleanup, restore transactions and OS/boot-chain updater
integration remain later S01/S03/S04/U02/K03 work. Runtime host-daemon restart
recovery of an interrupted app update retains its existing behavior; it is not
made health-verified by this lock change. This file lock is a coordination
mechanism for cooperating software, not a security boundary against a malicious
app that can write its own DATA directory.
