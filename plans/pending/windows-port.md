# Windows package: findings so far

Status: not started. The report-only CI job that ran the fixtures on Windows (`test-windows` in `.github/workflows/test.yml`, PR #248) has been removed; the findings below are from its last runs. Nothing in the app has been changed for Windows.

## Why

A Windows install (installer plus Windows service) for people who run Epilykos on a PC. Docker Desktop (WSL2) already works and is documented in the wiki repo; USB serial and Bluetooth don't pass through it easily.

## What should work as it is

Core app (Node 22, `better-sqlite3`, `serialport`, `modbus-serial`, `mqtt`, `ws`, `express`). Network sources: Modbus TCP, MQTT, Home Assistant, Wi-Fi dongles, REST, Tuya.

## Linux-only today

- Bluetooth: `modules/ble/ble_helper.py` talks to BlueZ. `bleak` supports Windows, but the helper needs porting and testing.
- Tailscale and Cloudflare Tunnel are bundled in the Docker image; "Update now" drives the Docker socket. A Windows build needs its own updater and a way to install or detect those tools.
- Serial: Linux device paths and a `udevadm` port scan. Windows uses COM ports.
- EpilykosOS appliance features do not apply.

## Install note

`better-sqlite3` 13 ships ready-made Windows binaries (`prebuilds/win32-x64.node`), but npm still runs `node-gyp rebuild`, which fails on the current Windows runner (Visual Studio 18 is not recognised by node-gyp 11.5). Install with `npm ci --ignore-scripts` to use the shipped binaries. `@serialport/bindings-cpp` also ships `win32-x64` prebuilds.

## Fixture results on Windows (windows-latest, Node 22.23.4)

149 of 206 pass, 57 fail.

| Cause | Count | Fixtures | Kind |
|---|---|---|---|
| `EPERM: fsync` on a file or folder | 27 | backup-secrets, compressed-snapshot, decrypt-failure, encryption, encryption-integrity, encryption-key-publication, logs, metrics-manager-delete, notifications-api, notifications-reports, poll-outcomes, restore-http-runtime, restore-input, restore-passphrase, restore-preparation, restore-rs232-runtime, restore-runtime, restore-runtime-caches, restore-staging-integration, restore-swap-recovery, restore-transaction, restore-upload-http, restore-upload-jobs, tuya-switches, tuya-unreachable, two-step, two-step-routes | Product. Windows cannot fsync a directory. Unguarded call sites: `modules/encryption.js`, `twoStep.js`, `dbCheck.js`, `restoreInput.js`, `restorePrepareCheck.js`, `restoreTransaction.js`; the `sync()` helpers in `compressedSnapshots.js`, `restoreStaging.js`, `restoreUploads.js`, `snapshotScheduler.js` are only partly guarded. |
| `spawn flock ENOENT` | 4 | backup-space-admission, os-update-guard, restore-preflight, shared-maintenance-lock | Product. The shared backup/restore lock shells out to `flock`; it needs a Windows implementation. |
| Unix socket in the temp folder: `listen EACCES` | 3 | os-updates-http, system-actions, updates | Appliance host interface; skip on Windows. |
| CRLF line endings in the checkout | 4 | breakdown, poll-guards, system-page-errors, docker-compose | Test artefact. Regexes expect LF; add `.gitattributes` with `eol=lf`. |
| SQLite `localtime` ignores `TZ` | 1 | page-load-speed | Product, needs a decision. Daily totals use SQLite `localtime`, which on Windows follows the Windows time zone, not the site time zone. |
| Temp folder still locked on cleanup (`EBUSY`) | 2 | auto-install, maintenance-notices | Mostly test cleanup (open database handles); check restore's file swap too. |
| Background workers stop early | 4 | backup-download-orphans, backup-worker-ownership, db-check-cancel, snapshot-worker-ownership | POSIX process and signal handling. |
| Front-end fixtures that use `import` | 6 | api-outage, button-card, dual-metric-card, dual-metric-logic, metric-trend-card, energy-costs-card | Not diagnosed; my re-run did not match how `test/run-all.js` starts them. |
| One-offs, not diagnosed | 6 | backup-downloads, cloudflared, inverter-names-repair, snapshot-scheduler, versioning, migration-backcompat | |

## Suggested order

1. Make `fsync` safe on Windows (one shared helper that skips directories on `win32`), a Windows lock to replace `flock`, and `.gitattributes` for LF. About 35 of the 57.
2. Re-run the Windows job; diagnose what is left (the `import` fixtures and the one-offs).
3. Decide the time zone approach (handle site-zone day boundaries in app code, or require the Windows zone to match).
4. Serial: COM port names and a Windows port scan.
5. Installer and Windows service (Node bundled, data in `%ProgramData%\Epilykos`), then an updater that checks GitHub releases.
6. Bluetooth last.

## Re-running the report

To get these results again, restore the `test-windows` job from the git history of `.github/workflows/test.yml` (it prints the failing fixtures and the first error of each in its job summary).
