# LuxPower local transports and GETA control verification

User-authorized scope: fix the reported LuxCloud/Epilykos differences, add GETA controls and a verification workflow for an available 3.6 kW GETA, deliver a PR against dev with technical evidence. Author: ashipaek0. No live device is connected in this workspace.

| Phase | Files | Acceptance / verification | Status |
|---|---|---|---|
| Correct shared telemetry | modules/dongle.js, new model helper, profile, decoder tests | SOC low byte; conditional current units; missing context omitted; poll/push consistency. Run node test/luxpower-analysis.test.js | verified locally |
| Wi-Fi transport | modules/dongle/luxpowerTcp.js, transport tests | Explicit off/required/auto; TLS PSK vector; fresh socket fallback; stop cancels negotiation; never replay writes. Run node test/luxpower-tls.test.js | verified locally |
| BLE transport | BLE JS/Python helper, fixtures | Existing long-write default; selectable chunked WNR; validated size; no retry write; diagnostics. Run node test/luxpower-ble.test.js and Python fake-client tests | verified locally |
| GETA controls | new settings module, dongle, Controls API/UI, profile | Live identity gate; bounded percentages, AC charge flag and schedules; serialized RMW, expected and readback; no unknown/model/firmware writes. Run control integration tests | verified locally |
| Settings and verification | settings UI/Test, Controls snapshot/export | Saved options applied to polling and Test; read-only export while locked; errors and partial reads visible | verified locally |
| Evidence and delivery | docs/luxpower, test/run-all.js | Include report/maps/excerpts, 3.6 kW checklist, exact tests and hardware limits; npm test; open PR against dev | verified locally |

Decisions: preserve existing protocol 5 and BLE long-write defaults; TLS default off for backward compatibility. Explicit auto permits plain fallback. Read-only snapshots use configured serials; no automatic reassignment of serials. New controls require the live app GETA predicate (holding19: single phase/device type13), with static evidence distinguished from hardware proof. Full holding catalogue is reference data, not a write allowlist. No firmware update, provisioning, reset, grid protection, model writes, or automatic restore/write sweeps. Existing generic controls remain compatible; new controls use stronger preflight and transaction semantics. Heartbeats remain a documented investigation unless validated by captures.

## Execution record

Implemented on `luxpower-geta-verified-controls`, rebased onto dev `29b5b8e`. Draft PR: https://github.com/ashipaek0/Epilykos/pull/172 . All commits authored by ashipaek0. Local full suite:128/128 fixtures,17,367 checks. Headless Chrome with a fake read-only GETA backend verified rendering, HH:MM reads, lock state and JSON download without exceptions. GitHub CI results are tracked on the PR.

Decisions refined during implementation: new controls use a separate `geta_controls` catalogue so generic widgets cannot treat packed flags/times as whole-word writes. Optional identity discovery failures are diagnostic and do not invalidate otherwise working legacy connection Tests. The verification export reuses polling's connection; temporary Settings Test should run with that poller disabled for a single-client dongle. An offline snapshot checker tolerates clock ticks while checking stable identity and target-word/bit preservation.

Hardware verification remains pending on the owner's3.6kW GETA and is explicitly not claimed by the app-model predicate or fake-device/software tests. The review guide, report, full decompilation bundle, source index/excerpts, machine-readable implemented definitions, offline checker, validation record and hardware checklist are in docs/luxpower. No physical device was contacted or written.
