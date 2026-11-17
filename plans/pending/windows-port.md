# Windows package: plan

Status: planned, not started. Beta. Nothing in the app has been changed for Windows. The findings from the old report-only Windows CI job (PR #248, since removed) are kept below as the work list.

## Decisions

- **Shape:** per-machine installer (Inno Setup `.exe`) that bundles Node and installs Epilykos as a Windows service (NSSM or `node-windows`). Data in `%ProgramData%\Epilykos`.
- **Label:** beta.
- **Bluetooth and Tailscale are in scope for the first release** (Cloudflare Tunnel with them, since the code treats the two alike).
- **Signing:** not bought. Apply to SignPath Foundation (free for open-source projects; GPLv3 qualifies; signs from GitHub Actions). Until approved, ship unsigned and say so on the wiki page (SmartScreen will warn).

## Guardrails: never slow or block the current pipeline

- New workflow `windows-package.yml` only. `test.yml`, `docker-build.yml`, `docker-build-dev.yml` are not edited and gain no Windows job or `needs:`.
- Triggers: `workflow_dispatch` and `release: published` only. Never push or pull_request.
- It builds and smoke-tests (install, start the service, `/healthz`, uninstall). It does not run the fixture suite, so Windows fixture failures cannot block anything.
- Own concurrency group. Output is a workflow artifact or a Release asset; the Docker image and epilykos-os dispatch are untouched.
- App changes are small PRs to `dev`, gated on `process.platform === 'win32'` wherever behaviour differs, so Linux and Docker behave exactly as today.

## Phases

1. **Runtime basics.** Shared `fsync` helper that skips directories on win32; a Windows replacement for `flock`; a data directory setting; `.gitattributes` with `eol=lf`; decide the SQLite `localtime` time zone approach; serial via COM ports (no `udevadm` scan); hide appliance and Docker-only features (host socket, Docker "Update now").
2. **Bluetooth.** `modules/ble/ble_helper.py` already uses `bleak`, which supports Windows (WinRT), so this is a port of the BlueZ-specific parts (D-Bus socket, adapter handling) and a test, not a rewrite. Bundle the embeddable Python plus `bleak` in the installer so users install nothing. Needs a real Windows machine with a JK or JBD battery to verify; CI can only check that the helper starts.
3. **Tailscale and Cloudflare.** `modules/tailscale.js` and `modules/cloudflared.js` spawn binaries (`TAILSCALED_BIN`, `CLOUDFLARED_BIN` already override the path). Two spikes first: (a) whether `tailscaled.exe` can run in userspace mode with its own state dir under `%ProgramData%\Epilykos`, alongside any Tailscale the user already has, or whether we must drive the official Windows client (named pipe, not a Unix socket); (b) bundle a pinned `cloudflared.exe`. The installer bundles what the spikes allow, otherwise offers to install Tailscale via winget and detects it.
4. **Packaging workflow.** `windows-latest`, `npm ci --ignore-scripts` (avoids the node-gyp failure noted below), prune dev dependencies, stage Node + app + Python/bleak + cloudflared, build the installer, smoke-test, upload.
5. **Updates.** Check GitHub Releases for a newer installer, shown in the existing update UI, hidden on Docker.
6. **Docs.** Wiki install page and a README line.
7. **After beta.** Re-run the fixture report (non-blocking) and clear the remaining Windows failures; sign the installer once SignPath approves.

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

## Earlier suggested order (superseded by Phases above)

1. Make `fsync` safe on Windows (one shared helper that skips directories on `win32`), a Windows lock to replace `flock`, and `.gitattributes` for LF. About 35 of the 57.
2. Re-run the Windows job; diagnose what is left (the `import` fixtures and the one-offs).
3. Decide the time zone approach (handle site-zone day boundaries in app code, or require the Windows zone to match).
4. Serial: COM port names and a Windows port scan.
5. Installer and Windows service (Node bundled, data in `%ProgramData%\Epilykos`), then an updater that checks GitHub releases.
6. Bluetooth last.

## Re-running the report

To get these results again, restore the `test-windows` job from the git history of `.github/workflows/test.yml` (it prints the failing fixtures and the first error of each in its job summary).
