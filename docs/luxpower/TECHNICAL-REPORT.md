# LuxCloud 5.0.0: local Wi-Fi and Bluetooth protocol analysis for Epilykos

> Historical analysis against commit `2792b1c`; the changes in this PR are described in [README.md](README.md). Class names below refer to the decompiled LuxCloud app, which is kept in a private analysis bundle and is not part of this repository.

Analysis date: 16 October 2026. Input: the user-supplied `LuxCloud_5.0.0_apkcube.apks`. Repository baseline: [`ashipaek0/Epilykos`, `dev`, `2792b1c179e8995831beebc670c823baed6ef1a4`](https://github.com/ashipaek0/Epilykos/tree/2792b1c179e8995831beebc670c823baed6ef1a4).

## Findings that matter

1. **Two telemetry corrections are supported by the app and reproduced against Epilykos.** SOC is the low byte of input register 5. BMS charge/discharge limits at inputs 81/82 use a model-dependent divisor of 10 or 100, rather than a universal 100. These affect both source modes because they share the decoder. See synthetic counterexamples (in the private analysis bundle).
2. **LuxCloud supports TLS-PSK over local Wi-Fi; Epilykos currently uses plain TCP.** The app tries TLS 1.2 on port 8000, then opens a fresh plain connection on handshake failure. This is a supported app path missing from the reviewed transport; whether a particular dongle requires it remains untested.
3. **BLE UUIDs are confirmed in full, but the write strategies differ.** Both use service `000000ff-0000-1000-8000-00805f9b34fb` and characteristic `0000ff01-0000-1000-8000-00805f9b34fb`. LuxCloud requests MTU 256 and submits chunks without response. Epilykos sends the whole frame with response. Existing hardware captures/tests support Epilykos's current implementation on at least the documented dongle; this analysis establishes a second compatibility strategy, not a universal failure of the current one.
4. **There is substantially more configuration evidence than the current profile exposes.** The map contains 1,200 family-scoped parameter/address associations: 510 distinct names and 265 distinct holding start addresses. These counts include aliases, individual bits, packed time fields, and repeated definitions across families. They are not 1,200 independently writable registers. All 1,200 address results agree between JADX and Androguard.

No inverter or dongle was contacted. No setting was written. “Confirmed” in this report means confirmed in the supplied app's static code unless explicitly identified as repository capture evidence. No new hardware validation occurred.

## Package and evidence quality

The archive SHA-256 is `5b711382e85150db387501a03f7bfd166a38ba5d130221d7645a75b02a524b77`. The extracted base APK SHA-256 is `46d04386356d9ad9c22cd7d880eb78a8a9fff1bf49869a41da6b57272ba7f7fc`. Package `com.lux.luxcloud`, version name `5.0.0`, version code `100`, minimum SDK 29, target SDK 36. Certificate and split hashes are recorded in the private analysis bundle (`package-inventory.json`). Recording the certificate fingerprint does not authenticate this mirror's distribution against a vendor release.

The app contains five DEX files, Android Java/Kotlin code, and bundled HTML/JavaScript setting interfaces. It is not a Flutter AOT application. The APK already supplies readable class and method names for the local connection and register machinery. Native Android classes, rather than unrelated web Bluetooth/battery-onboarding code, implement the inverter protocol examined here.

JADX 1.5.6 produced app source with **276 reported decompilation errors** across the entire APK, including library code and enum reconstruction. Its output must not be treated as recompilable original source. A separate Androguard DAD pass produced the selected protocol, connection, model, parameter, and local UI classes. Decompiled enum syntax, variable types, and double constants can be misleading in DAD output. The machine-readable address map is cross-checked against the second decompiler, and readable conversion branches are taken from JADX. Neither decompiler output is included in this repository: they are the vendor's code. This report, `implemented-controls.json` and the tests carry only the facts Epilykos relies on (addresses, bit masks, model rules), in our own words.

Evidence levels used:

- `app_static_confirmed`: a literal address, field extraction, expression, or behavior exists in the app. This does not establish firmware availability or safe write permission.
- Repository capture evidence: existing Epilykos fixtures described by that repository as real captures; this analysis did not independently recapture them.
- Conditional/inferred: physical meaning, applicability, or scaling depends on model/firmware or follows from a formula. The condition or uncertainty is retained.
- Unknown: represented by null or explicit notes. An unmapped address, unit, bit meaning, or limit is not filled from a generic LuxPower/Voltronic assumption.

## Connection architecture

`AbstractLocalConnect` implements the common operations: read holding, read input, write single, write multiple, and read/write dongle parameters. `TcpManager` and `BluetoothLocalConnect` implement the transports. Both deliver incoming bytes to `TcpAnalyzer` and use `DataFrameFactory` for translated inverter commands.

Source: `AbstractLocalConnect.java`, `DataFrameFactory.java`, `TcpAnalyzer.java`.

### Local Wi-Fi

The app connects to its dongle access-point address `10.10.10.1:8000`. This is the app's explicit address, not proof that an inverter's LAN address is always the same. Epilykos should retain configurable LAN hosts.

The current app path is:

1. Open a socket to port 8000.
2. Wrap it in a PSK TLS socket and try the handshake with a five-second deadline.
3. On handshake failure, close that connection and open a new plain TCP socket.
4. Use the common frame protocol over the selected connection.

The PSK configuration is explicit:

| Property | App value |
|---|---|
| TLS version | TLS 1.2 |
| Cipher suite | `TLS_DHE_PSK_WITH_AES_128_GCM_SHA256`, numeric 170 / `0x00AA` |
| OpenSSL cipher name | `DHE-PSK-AES128-GCM-SHA256` |
| PSK identity | `Client_identity` |
| Derivation | `HMAC-SHA256(key=ASCII("LuxPowerTek!"), message=dongleSerialBytes)[0:16]` |

The app does not uppercase, pad, or otherwise transform the serial inside `calcPsk`. The exact serial matters. It obtains a serial from the Wi-Fi SSID for the local connection flow. TLS does not change the application frame format.

Source: `TcpManager.java`, `PskTlsConfig.java`, `PSK_TLS_CONSTANT.java`, `DonglePskUtil.java`.

Do not infer that every installed dongle supports or requires TLS. A useful Epilykos extension is a selectable `off` / `required` / `auto` local transport policy with the selected mode and handshake failure visible in Test diagnostics. Preserve a fresh connection for fallback; sending plain frames into a failed TLS session does not reproduce the app.

### Bluetooth GATT

| Role | UUID |
|---|---|
| Service | `000000ff-0000-1000-8000-00805f9b34fb` |
| Write and notify characteristic | `0000ff01-0000-1000-8000-00805f9b34fb` |
| Client configuration descriptor | `00002902-0000-1000-8000-00805f9b34fb` |

These complete strings occur in the app. No Bluetooth-base suffix is being guessed.

The app enables notifications, writes the notification descriptor, then requests MTU 256. With the default MTU 23, its payload limit is 20 bytes. For a successfully negotiated MTU above 23 it uses `max(20, MTU-3)`. It sets Android write type 1, meaning write without response, and divides the full application frame into chunks. Each submitted chunk waits for a callback wake-up or up to 300 ms. This is not a mandatory 300 ms radio protocol delay. A rejected Android submission stops the operation. Notification bytes go individually to the shared analyzer, so notification boundaries are not application-frame boundaries.

Source: `BluetoothLocalConnect.java`, particularly GATT discovery/MTU callbacks and `sendPureCommand`.

Epilykos's reviewed helper instead calls `write_gatt_char(..., response=True)` on the entire frame. Its comments describe BlueZ long writes, and repository tests include BLE response fragmentation. The practical improvement is to support and diagnose both strategies using actual characteristic properties and negotiated write sizes. Do not remove a working long-write path solely because this app uses another path. Do not blindly send two copies after a timeout: a write may have been accepted even when its response was lost.

## Application frame and command formats

### Shared outer frame

All offsets below are zero based. Multibyte numbers are little endian.

| Offset | Bytes | Meaning |
|---:|---:|---|
| 0 | 2 | Magic `A1 1A` |
| 2 | 2 | Protocol prefix |
| 4 | 2 | Total frame bytes minus 6 |
| 6 | 1 | Constant 1 |
| 7 | 1 | TCP function |

The APK enum defines protocol prefixes 1 and 2; `AbstractLocalConnect` defaults to 2. Epilykos defaults to 5, and its existing capture fixtures use 5. **The app's default is not evidence that Epilykos's working v5 path should be replaced.** The common frame structure and CRC agree, but supported prefix/identity combinations still need hardware coverage.

Outer functions: `C1` heartbeat, `C2` translated inverter data, `C3` read dongle parameter, `C4` write dongle parameter.

Source: `AbstractTcpDataFrame.java`, `TCP_PROTOCOL.java`, `TCP_FUNCTION.java`.

### Translated inverter data (`C2`)

| Offset | Bytes | Meaning |
|---:|---:|---|
| 8 | 10 | Dongle serial bytes |
| 18 | 2 | Inner frame length, including inner CRC |
| 20 | 1 | Request action 0; ordinary reply action 1 |
| 21 | 1 | Device function |
| 22 | 10 | Inverter serial bytes |
| 32 | 2 | Start register |
| 34 | variable | Count/value/request body, or reply byte count and values |
| final 2 | 2 | CRC16/Modbus, little endian |

Normal commands:

- `03`: holding read. Request body at 34 is a u16 register count.
- `04`: input read. Same request shape.
- `06`: single holding write. Body at 34 is the u16 value.
- `10`: multiple holding write. Body is u16 count, u8 byte count, then `2*count` value bytes.

A read or single-write request is 38 bytes. A normal read reply contains u8 byte count at 34 and data from 35, with total length `37 + 2*count`. Register words and u32 pairs are little endian; a pair's lower-addressed word holds the low 16 bits. Existing Epilykos fixtures also cover the single-write echo shapes; the supplied codec accepts both its bare two-byte value and byte-count-prefixed two-byte value forms.

CRC: reflected polynomial `0xA001`, initial `0xFFFF`, xor-out 0, calculated over the inner bytes `frame[20:-2]`; store low byte first. The usual check string `123456789` gives `0x4B37`.

Source: `AbstractQueryCommand.java`, `WriteSingleCommand.java`, `WriteMultiCommand.java`, `TransferData.java`, `ProTool.java`.

The app also has exception and firmware-update device functions. Their literal codes are retained in `command-catalog.json`. That catalog is not a supported-command or write-permission list for Epilykos.

### Identity/bootstrap

The factory uses ten zero bytes for the inverter serial in ordinary local commands. Its fallback dongle serial is ten `FF` bytes. A BLE advertised name or Wi-Fi SSID can supply an actual dongle serial. Initial holding read 0/count40 returns the inverter identity in the outer/inner serial fields and model words in the values.

Useful identity fields in that holding block:

- Holding 0–1: u32 model. Battery type is `(model >> 8) & 3`; lead-acid subtype is `(model >> 10) & 31` when applicable.
- Holding 7–8: four standard/firmware-family text bytes.
- Holding 9: low byte communication version, high byte slave version.
- Holding 10: low byte firmware version.
- Holding 19: phase bit0 (`0`→1 phase, `1`→3 phases), device type bits1–4, DTC bits5–7, voltage class bit8; app ODM expression `(word >> 9) & 12`, machine type `(word >> 13) & 15`. The unusual ODM mask is preserved, not “corrected.”

`Inverter.isGeta()` checks device type 13 and single phase. Other family predicates use additional type, phase, model, machine, and firmware data. `LocalViewPagerAdapter` chooses local settings classes: type6→12K class, type3 or11→off-grid class, type9→Mid class, otherwise general class. These are UI routing rules, not a universal product model catalogue.

Source: `AbstractLocalConnect.java`, `Constants.java`, `Inverter.java`, `Model.java`, `LocalViewPagerAdapter.java`.

This supports a read-only onboarding/Test improvement: discover and display identity before asking users to enter two serials. A zero/wildcard discovery reply is not sufficient authority to enable arbitrary writes or classify an unknown device as GETA.

## Telemetry verified by the local app

The local overview reads input windows 0–39, 40–79, and 80–119. Its third-window completion flag means the app does not necessarily re-read BMS metadata on every overview cycle. Epilykos may reasonably choose its own refresh interval, but any scale flag must remain coherent with the values decoded from it.

The input map (in the private analysis bundle) lists 38 distinct native input references, including the separate PayGo result reference. The register-use inventory (in the private analysis bundle) preserves all literal accessor uses, including frame-relative indices and resolved read bases. It does not turn every existing Epilykos metric into APK-confirmed evidence.

### SOC

Input 5 is read using `FrameTool.getRegLowInt`, then shown as a percentage. `0x6450` therefore means SOC 80 for this field, not 25,680. The high byte's meaning is not established by that display path. A proposed SOH entity needs separate evidence.

Epilykos's profile declares the whole register as `uint16`, and the shared decoder has single-bit extraction but no general byte-width extraction on this path. Correcting only the profile label will not fix it. Add a general mask/shift field or an equivalent explicit derived field and test both mapped polling and unsolicited push decoding.

Source: `LocalOverviewFragment.lambda$sendRead04Command1$4`, `FrameTool.java`.

### BMS current limits

Inputs 81 and 82 are BMS charge and discharge current limits, not instantaneous battery current. The exact divisor hierarchy is in `Inverter.isBatCurrUnit10()`:

1. AC charger or Trip12K → divisor100.
2. Type6, all-in-one, or 7–10K family → divisor10.
3. Otherwise use the app's current-unit flag: input80 bit10 set → divisor10; clear → divisor100.

The app reads these fields when input80 low2 bits indicate lithium, or when the entire flag word is zero. It may use display defaults if a lithium model lacks a valid report. Those defaults are not measured values and should not be written to Epilykos history as measurements.

For a valid flag word `1026` (`0x0402`) with no overriding /100 family, raw660 means66A. The current GETA profile always multiplies by0.01, producing6.6A. The map keeps dynamic scale null with the condition described. Preserve the raw flags and identity context needed to decode it. Do not apply just bit10 globally without the family exceptions.

Source: `LocalOverviewFragment.lambda$sendRead04Command3$8`, `Inverter.java`.

### Power direction and derived values

The app confirms separate battery charge and discharge power words10 and11. A signed net-charge metric can be `input10-input11`, positive when charging. Its grid display uses `input26-input27`, with positive labeled Export and negative Import. Resource labels are included in `android-strings-default.json`.

Normal PV total is `input7+input8+input9`; the AC-charger branch handles register7 differently. Normal usage power is `max(0, input16-input17+input27-input26)`; the AC-charger branch additionally includes register7. EPS power comes from24 when state0≥64. Keep signed raw derived values separate from app presentation clamping when diagnosing power balance. Do not assume AC-charger exceptions apply to GETA.

### Energy and app defects worth avoiding

The app shows daily generation from28+29+30 and daily discharge from34, dividing by10 for kWh. It shows total discharge from u32 inputs52–53 and total export from u32 inputs56–57, also /10. Fault and warning aggregate words are u32 at60 and62; nonzero values control status icons. This trace does not establish individual alarm bits.

The app's total-generation expression reads the first component at40 with a u32 accessor but the components at42 and44 with u16 accessors. That can truncate accumulated values. **Do not downgrade Epilykos's existing u32 energy decoding to copy this apparent app defect.** The input map records the accessor evidence and explicitly leaves those components' true protocol width unestablished by that accessor alone.

## Configuration register map

`holding-register-map.json` and its CSV contain the resolved start registers from five local UI classes. Every row retains family/class, parameter identifier, address, packed bit metadata where resolved, conversion/display branches, source references, and hardware-verification status. Scale is established for734 associations; remaining values are null rather than guessed. A scale value is still scoped to its row's class and conversion branch.

Examples of settings exposed in the APK include charging/discharging percentages, AC charging thresholds and schedules, generator charging, lead-acid charging and cutoff voltages, equalization, PV start voltage, feed-in control, grid connection/protection, EPS behavior, parallel operation, smart load/AC coupling, fan controls, and MidBox port settings. A firmware or hardware condition in a source branch remains significant even if its start address is shared with another family.

Examples of relatively consistent address references:

| Holding address | App identifier / role |
|---:|---|
| 20 / `0x0014` | `HOLD_PV_INPUT_MODE` |
| 21 / `0x0015` | Several packed function enables; AC charging is bit7 |
| 64 / `0x0040` | `HOLD_CHARGE_POWER_PERCENT_CMD` |
| 66 / `0x0042` | `HOLD_AC_CHARGE_POWER_CMD`; conversion varies by class |
| 75 / `0x004B` | Forced/charge-first SOC limit naming in source |
| 99 / `0x0063` | Lead-acid charge voltage reference |
| 100 / `0x0064` | Lead-acid discharge cutoff voltage |
| 105 / `0x0069` | Discharge EOD SOC |
| 110 / `0x006E` | Additional packed function settings |
| 120 / `0x0078` | Packed charging/discharging-control selectors |
| 125 / `0x007D` | EPS discharge SOC low limit |
| 160,161 / `0x00A0–A1` | AC charge start/end SOC |
| 196,197 / `0x00C4–C5` | Generator charge start/end SOC |
| 227 / `0x00E3` | Battery stop-charge SOC |

The names and conversions in the machine map are authoritative over this abbreviated table. The source's address resolver also includes identity/version fields. Consequently `write_allowed` is null throughout: address existence is not proof that a field is writable, applicable, or appropriate to expose.

Packed flags and selectors use read-modify-write. Packed time words place hour in the low byte and minute in the high byte. RTC is six bytes at holding12–14: year minus2000, month, day, hour, minute, second; the app uses a three-register multiple write. Model u32 fields and some MidBox writes need more than a single-register edit. Preserve untouched bytes/bits and require readback.

The app's own write acknowledgment checks are weaker than Epilykos's guarded Controls workflow. Preserve Epilykos's unlock, expected-value checks, per-device serialization, bounds, and readback when adding supported controls. Do not import all map entries as a write allowlist or reuse one family's ranges for every device.

### Dongle parameters and non-monitoring paths

Dongle parameters use outer C3/C4, a separate address space from inverter holding/input registers. The datalog map (in the private analysis bundle) records15 observed indices, including serial, Wi-Fi provisioning, server address, firmware/capability data, AP encryption/password, IP configuration, restart/reset, and first-use status.

A C3 read payload is ten serial bytes plus u16 parameter index. A C4 write payload adds u16 byte length and the parameter bytes. These paths do not carry the translated inverter inner CRC. The application payload builders and reader response parsing are retained as source; do not assume C2 offsets apply to them.

The app also declares `HOLD_TOKEN_CONFIG` at359 with count11 and text type, and reads the low-byte PayGo token result at input264 in a 240/count40 response. These are documented for completeness, not proposed as ordinary Epilykos controls. Firmware-update commands and network resets are likewise separate from monitoring/source-mode improvements.

## Epilykos comparison and implementation priorities

The reviewed `dev` has225 profile metrics (167 input,58 holding),20 two-register u32 entries, and8 explicitly listed writable settings. Both TCP and BLE use the same profile and core decoder. The namespace separation of input/holding words, CRC checks, fragmented-stream handling, serialization, and readback workflow should remain in place.

The preserved baseline sources and an address-only crosswalk are under comparison/ (in the private analysis bundle). A matching address in that crosswalk does not by itself verify a label, scale, or model's support.

| Priority | Change | Evidence and practical limit |
|---|---|---|
| 1 | Decode SOC as low byte in both polling and pushes | Direct app accessor; synthetic reproduction against current decoder |
| 1 | Implement context-dependent BMS current scaling and invalid-report handling | Direct app branch and model predicates; fixed /100 produces a 10× error on the /10 branch |
| 2 | Add local TLS-PSK transport policy and Test diagnostics | Exact app derivation, cipher, identity and fallback flow; needs live TLS dongle capture |
| 2 | Add BLE chunked write-without-response as a diagnosed compatibility mode | Exact app chunk/MTU strategy; preserve the existing validated long-write mode |
| 2 | Add read-only serial/model/firmware discovery | App's holding0/count40 bootstrap; verify identities before assigning a family |
| 3 | Add selected GETA controls with class/model-specific bounds and conversions | 1,200 resolved associations are a reference catalogue, not an automatic controls list |
| 3 | Expose transport mode, MTU/write size, raw flags and identity in Test | Makes transport and scale choices inspectable without repeated credential collection |
| Investigate | Heartbeat C1 handling on persistent local sessions | App sends a heartbeat response; Epilykos's translated parser accepts only C2. No new evidence here proves disconnects without an acknowledgment. |

For new settings, start with ordinary battery/charging controls demonstrably applicable to the identified GETA family. Treat grid protection, model reconfiguration, firmware update, resets, and provisioning as separate scopes. The existing eight settings do not need to be discarded simply because the app contains many more.

Recommended verification sequence: compare read-only identity and raw words over both transports; compare decoded values with the app while raw frames are captured; test both BLE write strategies and MTU23/negotiated MTU; test TLS-required and legacy dongles; then validate any new setting one at a time with expected value and independent readback. Capture polling and unsolicited pushes, including malformed/short/exception frames and simultaneous UI activity. A synthetic fixture passing is not hardware confirmation.

## Analysis tools (not in this repository)

The tools below, the decompiler outputs and the original logs are kept in the private analysis bundle, outside this repository.


- `scripts/lux_codec.py`: offline read/single-write/multi-write frame construction, CRC, stream reassembly, BLE chunk planning, and partial app-confirmed telemetry decoding. Frame construction does not perform writes.
- `scripts/read_local.py`: explicit-target, read-only Wi-Fi/BLE probe. Wi-Fi TLS-PSK requires Python3.13+ with compatible OpenSSL; BLE requires Bleak. It sends only holding/input reads. It is a one-shot diagnostic, not a production daemon or a complete heartbeat client.
- `scripts/capture_app.js`: optional Frida hooks for app TX/RX translated frames, including app plaintext above TLS. It injects no commands. C3/C4 provisioning traffic is deliberately omitted because it can contain Wi-Fi credentials. The hooks have not been tested on a live Android process.
- `scripts/extract_registers.py` and `enrich_registers.py`: reproduce the holding map from the two decompiler outputs. `decompile_android.py` reproduces the selected DAD pass from the original base APK when Androguard is installed.
- `scripts/compare_epilykos.js`: reproduces the synthetic SOC/current counterexamples against an installed Epilykos checkout, without device I/O.
- `scripts/test_codec.py`:16 offline tests passed, including the existing repository request vector, read reassembly, CRC rejection, write frame shapes, chunk sizes, family-dependent scales, and map cross-check coverage.

The existing Epilykos targeted frame, socket, and BLE suites passed:2,081,56, and25 checks respectively (2,162 total). They were run against the archived `dev` sources at the time; the logs are in the private bundle. These suites test existing behavior and do not contain the new failing-value cases; those counterexamples are supplied separately.

The provided network/Bluetooth probe, PSK handshake against hardware, Frida instrumentation, and new settings remain **hardware-unverified**. No claim is made that every address in the map exists on the user's inverter or that every decompiled UI path works correctly in the app.
