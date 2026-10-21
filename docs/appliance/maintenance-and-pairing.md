# Appliance maintenance and Bluetooth pairing

This batch needs both Epilykos and EpilykosOS changes. Ordinary Docker installations retain the database check and backup reminder; host controls appear only on an appliance.

- Settings → System shows the backing card size, site time zone and network clock state. Cards below 28 billion bytes warn (marketed 32 GB cards hold 29.5 to 32 billion); 64 GB is recommended. Unknown size is reported as unavailable. The clock can be corrected from the browser; NTP stays enabled. UTC timestamps already stored are untouched.
- Setup → Basics prefills the site time zone from the browser on a fresh appliance. The host validates IANA zone files, stores the selection on DATA and passes `TZ` on container startup. Changing it restarts the app.
- Settings → System → Pair a Bluetooth device opens a five-minute BLE pairing window. Select the nearby device, then enter its PIN/passkey or confirm the displayed code. PIN input survives status polling. Closing/expiry cancels pending requests and preserves completed bonds. Forget removes a bond. This does not implement a new source protocol or Classic Bluetooth serial support.
- A running marker detects an unclean application stop. A read-only worker runs SQLite `quick_check` one minute after startup following an unclean stop, and weekly. It shares the maintenance lock with restore/backup and never participates in boot readiness. Results are saved outside the database so a damaged config table cannot hide the finding. No automatic repair is attempted. A database too damaged for the application to start still needs recovery outside the dashboard.
- A monthly backup reminder tracks completed backup HTTP downloads. Daily snapshots on the same card do not satisfy it. The reminder can be deferred seven days. A successful transfer does not prove the browser retained the file; copy it off-device.
- Settings → Updates offers automatic **app** installation, off by default. Enabling requires the admin password and daily checks. Only a fresh host-verified manifest with the matching digest and sequence can be installed. The host durably records an automatic attempt before starting; failures are rolled back and not retried automatically. Manual retry remains available. Turning daily checks off pauses automatic installation. OS bundle installation is not added here.

## Host interface

Authenticated `/api/system` forwards only named fields; the normal API CSRF checks apply. New actions are `set_timezone` (`timezone`, `restart`), `set_clock` (`epoch`), `bluetooth_status/open/close/pair/reply/remove` (`address`, or request `id` and `value`). No PIN is logged or persisted. `status` adds `clock` and `storage`.

`/run/epilykos/clock.json` is refreshed every 15 seconds and mounted read-only as `EPILYKOS_CLOCK_FILE`; absent/stale clock state warns. `/api/notices` provides clock, database and backup state plus dashboard warnings. POST `/api/notices/database/check` returns 202 immediately.

## Verification recorded 2026-10-17

App suite: 132 fixtures passed (17,482 checks before three additional auto-install authentication assertions; those assertions passed separately). Real SQLite tests exercise healthy/damaged files, concurrent checks, marker lifecycle and backup aging. Fake-host tests check the route field allowlists.

A local browser harness exercised open → device selection → zero-prefixed passkey → paired → close, retained the paired device, showed 16 GB/unsynchronized clock warnings and reported no browser errors. All four actions carried the CSRF header. This is browser behavior against a stand-in backend, not radio evidence.

OS tests use real Agent1 D-Bus messages on a private bus against fake BlueZ, real Ed25519 signatures and stand-in Podman/systemctl commands. They cover PIN, passkey, confirmation, unsolicited/stale/expired requests, cancellation, retained bonds, invalid signatures, rollback and at-most-once automatic attempts.

## Pi 3B acceptance after flashing

1. Confirm the intended app commit and OS version in Settings. Confirm 64 GB storage does not warn; a 16 GB card should warn. Never use a production database for the small-card test.
2. Choose the site's time zone, restart, and check daily boundaries. Boot offline and verify the clock warning; restore network and check it clears. Test browser clock correction with sources paused.
3. Pair a PIN-requiring BLE device. Test wrong PIN, correct PIN, cancellation, five-minute expiry and reboot bond retention. Verify Wi-Fi setup and normal inverter readings afterwards. Pairing alone does not establish that a given inverter protocol is supported.
4. With disposable data, stop the app uncleanly and verify the delayed check runs without blocking health/dashboard access. Download a backup and verify reminder state. Keep the actual backup outside the card.
5. On a development appliance, enable automatic installation, publish a signed test app release, and verify health promotion. Test a failed candidate and verify rollback/no automatic retry. Keep automatic installation off on production until these hardware checks pass.

No physical Pi or inverter was accessed during this change. The image build and QEMU checks cannot establish real radio interoperability.
