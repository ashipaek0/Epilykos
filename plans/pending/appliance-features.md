# Appliance feature completion

Authorized by the user: finish the feature batch from the referenced session, integrate into dev, then trigger the Pi 3B image build. The unpublished session branches are absent from GitHub, so recreate and verify against current dev.

## Decisions
- Keep automatic app installation off by default; host verifies signatures and handles rollback. Never install an unsigned feed entry.
- Run SQLite quick_check in a read-only worker after an unclean stop and weekly; show findings independently of boot health.
- Warn below 32 decimal GB, allowing marketed 32 GB cards; remind monthly about downloaded backups (local snapshots are not off-device backups).
- Persist IANA time zone on DATA, pass TZ to the container, expose NTP state and an authenticated manual correction path.
- Pair BLE devices only during a five-minute window, with a selected device and interactive PIN/passkey requests. Reject unsolicited pairing. Preserve BlueZ bonds on DATA.
- Target dev in both repositories. Verify published app digest before building OS. Do not promote a stable release as part of this development build.

## Steps and verification
| Phase | Size | Files | Acceptance / command | Progress |
|---|---|---|---|---|
| Maintenance notices | M | modules/dbCheck.js, notices.js, backup.js; routes/notices.js; dashboard/settings JS | Unclean marker, healthy/corrupt DB and backup aging tests; npm test | pending |
| Host state | M | epilykos_system.py, hostd, run, app system settings | SD detection, timezone validation, clock state/correction; make test | pending |
| Pairing | M | epilykos_bluetooth.py, hostd, app system routes/UI | Fake BlueZ tests for expiry, PIN, rejection and bond retention | pending |
| Signed automatic release/install | M | update modules/UI, release workflows/contracts | Opt-in verified-only/once-per-release tests; workflow syntax; make contracts | pending |
| Integration/build | S | manifests/dev.yaml, evidence | Both PR checks green; new image digest pinned; OS image run created on dev | pending |

Always include regression tests for state transitions and failure paths. Never claim hardware verification from mocks or QEMU. Keep existing inverter integrations intact.
