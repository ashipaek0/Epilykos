# LuxPower local transports and GETA control verification

User-authorized scope: fix the reported LuxCloud/Epilykos differences, add GETA controls and a verification workflow for an available 3.6 kW GETA, deliver a PR against dev with technical evidence. Author: ashipaek0. No live device is connected in this workspace.

| Phase | Files | Acceptance / verification | Status |
|---|---|---|---|
| Correct shared telemetry | modules/dongle.js, new model helper, profile, decoder tests | SOC low byte; conditional current units; missing context omitted; poll/push consistency. Run node test/luxpower-analysis.test.js | pending |
| Wi-Fi transport | modules/dongle/luxpowerTcp.js, transport tests | Explicit off/required/auto; TLS PSK vector; fresh socket fallback; stop cancels negotiation; never replay writes. Run node test/luxpower-tls.test.js | pending |
| BLE transport | BLE JS/Python helper, fixtures | Existing long-write default; selectable chunked WNR; validated size; no retry write; diagnostics. Run node test/luxpower-ble.test.js and Python fake-client tests | pending |
| GETA controls | new settings module, dongle, Controls API/UI, profile | Live identity gate; bounded percentages, AC charge flag and schedules; serialized RMW, expected and readback; no unknown/model/firmware writes. Run control integration tests | pending |
| Settings and verification | settings UI/Test, Controls snapshot/export | Saved options applied to polling and Test; read-only export while locked; errors and partial reads visible | pending |
| Evidence and delivery | docs/luxpower, test/run-all.js | Include report/maps/excerpts, 3.6 kW checklist, exact tests and hardware limits; npm test; open PR against dev | pending |

Decisions: preserve existing protocol 5 and BLE long-write defaults; TLS default off for backward compatibility. Explicit auto permits plain fallback. Read-only snapshots use configured serials; no automatic reassignment of serials. New controls require the live app GETA predicate (holding19: single phase/device type13), with static evidence distinguished from hardware proof. Full holding catalogue is reference data, not a write allowlist. No firmware update, provisioning, reset, grid protection, model writes, or automatic restore/write sweeps. Existing generic controls remain compatible; new controls use stronger preflight and transaction semantics. Heartbeats remain a documented investigation unless validated by captures.
