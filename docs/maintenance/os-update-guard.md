# EpilykosOS update guard (guard-v1) and Settings › Updates

This is the app half of OS updates from Settings. The OS repository's design is in `plans/decisions/os-dashboard-updates-design.md` §7.4 and §10.

## The guard

A paired EpilykosOS (protocol-2 cards) mounts the host's public OS-update directory read-only at `/run/epilykos-os-updater`. It also sets `EPILYKOS_OS_UPDATE_GUARD=/run/epilykos-os-updater/guard.json`. The image declares the capability with `io.epilykos.os-update-guard=guard-v1`, and the host offers no OS install to an app without it.

`modules/osUpdateGuard.js` reads the guard under the shared maintenance lock, because `acquireLock('maintenance')` holds the file lease while it reads.

| Guard | App maintenance |
|---|---|
| `idle` | everything |
| `pending` (an update is ready or on trial) | backups, downloads, snapshots, integrity checks, retention and staging cleanup. Restore (uploads and the swap) is refused, because it changes what the confirmed fallback app must read |
| `active`, `reconciling` | nothing |
| named but missing or unreadable | treated as `reconciling` (fails closed) |
| not named (Docker, development, older EpilykosOS) | everything, as before |

A refusal is a `LOCK_BUSY` error with a sentence pointing to Settings › Updates, and the lease is released. Callers that may run while an update is pending pass `allowPendingOsUpdate: true`.

The host independently refuses its own conflicting actions (restart, shutdown, factory reset, port changes, app updates).

## Routes

All routes need a signed-in admin and CSRF, as every `/api/updates` route does.

| Route | Host action | Notes |
|---|---|---|
| `GET /api/updates` | `os_status` | `os` is the EpilykosOS card's state |
| `POST /api/updates/os/check` | `os_check` | remembers what was offered; one notification per release |
| `POST /api/updates/os/install` | `os_install` | password; `sequence` and `sha256` must equal the last offer (409 otherwise); `request_id` makes repeats idempotent |
| `POST /api/updates/os/cancel` | `os_cancel` | until installing starts |
| `POST /api/updates/os/restart` | `os_restart` | password; names the job |
| `POST /api/updates/os/discard` | `os_discard` | password; names the job |
| `POST /api/updates/os/dismiss` | `os_dismiss` | a finished job's result |

The password is checked by the app and never sent to the host. `POST /api/updates/apply` with `target: "os"` is refused, so system updates go only through the card. The daily check also runs `os_check`, which notifies but never installs.

## Tests

- `test/os-update-guard.test.js`: every guard state with the real file lease.
- `test/os-updates-http.test.js`: the routes against a fake host.
- `test/os-updates-ui.test.js`: the card running in a stub page.
