# LuxPower GETA changes and verification

This branch targets `dev` and uses the supplied LuxCloud 5.0.0 APK as static evidence. The available hardware for follow-up is the owner's **3.6 kW GETA**. No live inverter was accessed during development. Device power rating is not inferred from the model discriminator.

Read the [technical report](TECHNICAL-REPORT.md) and the [implemented control evidence](implemented-controls.json). The decompiled LuxCloud code and the full analysis bundle are kept outside this repository: they are the vendor's code, and this public GPL repository must not redistribute them. The `evidence` fields name the class and line in that private bundle.

## Changes

- Shared Wi-Fi/BLE polling/push decoder: SOC uses input5 low byte. BMS limits81/82 use the app model predicates and input80 bit10. Type2/three-phase type0 force /100; types6/7/8 force /10; other types follow bit10. Lithium reports or zero flags are accepted. Missing model/flags and other battery types omit these measurements; app placeholder currents are not published. Model context expires after five minutes; old measurements are not merged into partial pushes.
- Wi-Fi: `tls_policy` is `off` (default), `required`, or `auto`. TLS1.2, DHE-PSK-AES128-GCM-SHA256, identity `Client_identity`, PSK = first16 bytes of HMAC-SHA256(key `LuxPowerTek!`, exact dongle serial). Auto falls back on a **fresh socket before sending any application frame**. A failed/uncertain setting write is never replayed by fallback. This is vendor-compatible TLS: its PSK is reproducible from the dongle serial and app literal, not an independently provisioned private secret.
- BLE: `ble_write_mode` is `long-response` (default) or `chunked-no-response` (LuxCloud strategy). Chunk size respects the negotiated MTU/characteristic maximum, and WNR must be advertised. Default inter-chunk delay is300ms; optional JSON configuration `ble_chunk_delay_ms` accepts0–1000ms. This conservative delay is not a claim that the app always waits300ms: Android wakes earlier on write callbacks. No automatic mode-switch retry.
- Local protocol is selectable (5 retained by default; app uses2). Settings/Test and polling use the selected options. Existing validated long writes and 32-bit energy counters are preserved.
- Test reads holding identity/model/firmware, reporting discovery errors separately from a successful telemetry read. Monitoring and named Controls continue to use the poller's shared connection where available.
- Twelve additional named controls, listed below, require a fresh single-phase/type13 GETA identity, valid current value, typed expected value, serialization, and exact full-word readback. They live in `geta_controls`, separate from generic widget register permissions. Existing eight SOC controls remain available with their existing guards.
- Controls → **Download verification** collects sequential raw holding/input reads, model/firmware, serials, current-limit flags/divisor, decoded settings, transport diagnostics, per-range errors/timestamps and the device change log. It works with writes locked/off and sends no settings writes. Downloads are snapshots, not atomic samples or proof that labels are correct.

| New control | Holding word | Value |
|---|---:|---|
| Battery charging power limit |64 /0x0040|0–100%, step1|
| Battery discharging power limit |65 /0x0041|0–100%, step1|
| Grid charging power limit |66 /0x0042|0–100%, step1 in the traced general-family UI|
| Grid charging enable |21 /0x0015|bit7|
| Charge-first enable |21 /0x0015|bit11|
| Forced-discharge enable |21 /0x0015|bit10|
| Grid charging window1 start/end |68/69|hour low byte, minute high byte|
| Grid charging window2 start/end |70/71|hour low byte, minute high byte|
| Grid charging window3 start/end |72/73|hour low byte, minute high byte|

The model predicate is an app-family check, **not hardware certification**. Firmware can reject/limit a value. A model mismatch or invalid current format blocks new controls. Do not bypass this with expert raw writes; record the verification data for review instead. Zero/equal or overnight schedule interpretation needs checking against the actual unit; this branch does not invent disable or duration semantics. Grid/protection settings, model changes, RTC writes, firmware, provisioning and resets are outside this PR. C1 heartbeat behavior remains an investigation, not a claimed disconnect fix.

## Verify the 3.6 kW GETA

1. Record the inverter and dongle label model/serial,3.6kW rating, firmware shown in LuxCloud, battery type and local clock. Keep existing settings unchanged initially. Use Settings → Sources → LuxPower GETA with the label serials and correct network host or Bluetooth address. Leave protocol5 and the existing transport defaults first. Saving restarts polling.
2. Close LuxCloud before Epilykos connects; the dongle may allow only one client. For a temporary connection Test, stop/disable an existing poller for the same dongle first. For saved devices, use Controls verification/read buttons, which share the poller's connection.
3. With changes locked/off, download a **before** verification JSON. Check `complete`; failed reads are recorded explicitly. Confirm identity says single-phase/type13 GETA and compare every proposed new setting with LuxCloud, taking turns owning the connection. If a value/label differs, do not change that control. Do not infer applicability from a value merely falling in0–100.
4. Compare SOC, rawinput5, input80 flags, inputs81/82 and the selected divisor with the app. A zero/high SOC byte must not inflate the percentage. Current-limit comparison concerns BMS limits, not instantaneous battery current; it may be unavailable on non-lithium reports. Changes to real operating current/load are not a substitute for inspecting the flags.
5. Verify Wi-Fi and Bluetooth separately. Record `tls_policy`, protocol and selected mode. Try TLS-required only as a read test; record unsupported handshakes. Explicit auto may choose plain fallback. Compare the two BLE strategies using read-only requests first and record MTU/chunk size from a verification file. The availability of a software mode does not imply this dongle supports it.
6. After confirming meanings, unlock Controls and enable device changes. Read a single control. For a percentage above0, a one-point reduction is a useful first test; do not increase a device's charge/discharge limits simply for testing. Confirm the intended original/new values in the dialog. Check the reported readback and download **after** JSON. Independently verify LuxCloud/panel shows the new value. Record any actual charging/output effect separately under suitable operating conditions.
7. For flags, compare holding21 before/after: only the selected bit should change. For a schedule, confirm the local clock and compare both hour/minute bytes. Keep grid/charge-first/forced-discharge modes appropriate to the installation while testing schedules. Do not run an automated toggle or control sweep.
8. Restore the recorded original value only through another explicit read/change/readback, using the latest expected value. Download a **restored** JSON. A timeout or `sent_unverified` means the command may already have applied: read/check it before any retry or restore. Lock changes when finished.
9. Retain before/after/restored snapshots and a completed [verification record](verification-record.json). The files include serials and settings. Share them only where appropriate. A matched register readback establishes persistence, not the physical meaning or correctness of every function.

Optional offline persistence check (no device I/O):

```sh
node scripts/verify-luxpower-snapshots.js before.json after.json charge_power_percent 49
node scripts/verify-luxpower-snapshots.js before.json after.json ac_charge_enabled true
node scripts/verify-luxpower-snapshots.js before.json after.json ac_charge_start_time_1 10:30
```

Supply the value actually requested, not these illustrative values. The tool checks identity/serial consistency, valid formats, expected raw word and preservation of unrelated bits. Other holding changes are reported for review; dynamic input readings are not expected to match. It does not certify hardware semantics.

## Developer validation

Run `npm test`. Focused checks: `node test/luxpower-analysis.test.js`, `node test/luxpower-tls.test.js`, `node test/luxpower-controls.test.js`, `node test/luxpower-ble-write.test.js`, `node test/luxpower-ble.test.js`, `node test/device-controls.test.js`, and `node test/phocos-controls-ui.test.js`. The TLS tests use a real local PSK server; BLE writes and inverter operations use fake clients/devices. See `validation.json` for the final result. Hardware results are intentionally unfilled until the owner's test.

## 24 V GETA 3.6 kW profile

`profiles/dongles/luxpower-geta-3k6-24v.json` ("LuxPowerTek GETA 3.6kW 24V") is the same dongle family (Wi-Fi / Bluetooth, `luxpower-tcp`, explicit mapping) cut down to what the 24 V unit (GETA-LB-EU 3.6K/24V: one MPPT, single phase, 230 V) has, from the LuxPowerTek Modbus RTU register table and the 24 V register polling configuration:

- 114 entities instead of 225. Left out: PV2 to PV6, the S and T phases, split-phase (L1N/L2N), AFCI and the grid auto-test, smart load and AC couple, meter offsets and the lead-acid temperature guards.
- Input and holding registers are read in five 40-register blocks (0-39 to 160-199) that never cross a boundary; the general profile also reads 200-279.
- Same twelve named controls and the SOC settings the 24 V documents list (stop-discharge SOC on grid and off grid, grid and generator charge start/stop SOC). Two the documents do not list (charge-first stop SOC, stop-charge SOC) are not offered.
- Temperatures are signed.
- Voltages are 0.1 V (240 = 24.0 V). Read the battery settings (charge voltage 99, cut-off 100, float 144, grid-charge 158 to 169) on the unit before writing any of them.
- Battery SOH shares input register 5 with SOC (high byte); a source maps one metric to a register, so only SOC is offered.

The documents also describe the RS-485 frame (the 10-character serial number inside every request). That wired transport is not implemented: this profile is for the dongle.

The older profile, `luxpower-geta`, is now named **LuxPowerTek Generic Hybrid (multi-PV, 3-phase, split-phase)**: it is the one for the other LuxPowerTek models, with PV2 to PV6, the S and T phases, split-phase, smart load and AC couple. Its id is unchanged, so saved sources keep working.
