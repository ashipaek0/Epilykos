"""
Epilykos Bluetooth LE helper.

A long-lived child process owned by modules/ble.js. It talks to the host's
BlueZ over the system D-Bus socket (bleak), so the container needs neither
host networking nor privileged mode — only /run/dbus mounted.

Protocol: one JSON object per line.
  stdin  <- {"id": 1, "cmd": "scan", "args": {...}}
  stdout -> {"id": 1, "ok": true, "result": ...}
            {"id": 1, "ok": false, "error": "...", "code": "..."}
The first stdout line is {"event": "ready", ...}. Logs go to stderr.

Commands run one at a time: a single adapter cannot scan and connect
reliably in parallel.

Commands
  status                      adapter / D-Bus / library availability
  scan        {timeout, all}  discover devices; BMS types identified via aiobmsble
  read_bms    {address, timeout}             one aiobmsble sample, flattened to numbers,
                              plus "__kind" (the aiobmsble module, e.g. jbd_bms)
  modbus      {address, write_uuid, notify_uuid, frame, timeout}
                              send one Modbus-RTU frame over a GATT write/notify
                              pair and return the complete response frame (hex)
  gatt_read   {address, reads: [{service, characteristic}], timeout}
                              read characteristics (read-only devices that expose
                              live values directly, e.g. Phocos Any-Grid)
  bms_switch  {address, bms_type, switch, on, charge_on, discharge_on, timeout}
                              turn a JBD or JK pack's charging or discharging
                              on/off (the only BMS writes); returns the type
  disconnect  {address}       drop cached connections for one device
  disconnect_all
"""
import asyncio
import json
import logging
import os
import sys
import time

logging.basicConfig(
    stream=sys.stderr,
    level=os.getenv("BLE_LOG_LEVEL", "WARNING").upper(),
    format="%(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("ble-helper")

DBUS_SOCKET = os.getenv("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")
SEEN_TTL = float(os.getenv("BLE_SEEN_TTL", "600"))  # reuse a scan result for 10 min
KEEP_ALIVE = os.getenv("BLE_KEEP_ALIVE", "true").lower() not in ("0", "false", "no")
MAX_DEVICES = 256  # scan results kept in memory


class HelperError(Exception):
    def __init__(self, message, code="error"):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Pure helpers (no Bluetooth imports — covered by --self-test)
# ---------------------------------------------------------------------------

def norm_address(address):
    if not isinstance(address, str):
        raise HelperError("address required", "bad_request")
    addr = address.strip().upper()
    parts = addr.split(":")
    if len(parts) != 6 or not all(len(p) == 2 and all(c in "0123456789ABCDEF" for c in p) for p in parts):
        raise HelperError(f"invalid Bluetooth address: {address!r}", "bad_request")
    return addr


def _num(v):
    """int/float/bool/IntEnum -> JSON number; anything else -> None."""
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v != v:  # NaN
            return None
        return int(v) if isinstance(v, int) else v
    return None


def flatten_sample(sample):
    """aiobmsble BMSSample -> flat {key: number}.

    Scalars keep their aiobmsble names (voltage, current, battery_level, ...).
    Lists become numbered keys: cell_voltages -> cell_voltage_1.., temp_values
    -> temp_1.., packs -> pack_1_voltage... Non-numeric values are dropped.
    """
    out = {}
    if not isinstance(sample, dict):
        return out
    for key, val in sample.items():
        if key == "cell_voltages" and isinstance(val, (list, tuple)):
            for i, v in enumerate(val, 1):
                n = _num(v)
                if n is not None:
                    out[f"cell_voltage_{i}"] = n
        elif key == "temp_values" and isinstance(val, (list, tuple)):
            for i, v in enumerate(val, 1):
                n = _num(v)
                if n is not None:
                    out[f"temp_{i}"] = n
        elif key == "packs" and isinstance(val, (list, tuple)):
            for i, pack in enumerate(val, 1):
                for pk, pv in flatten_sample(pack).items():
                    out[f"pack_{i}_{pk}"] = pv
        else:
            n = _num(val)
            if n is not None:
                out[key] = n
    return out


def modbus_frame_length(buf, unit_id, fc):
    """Expected total length of a Modbus-RTU response in buf, or None if more
    bytes are needed. Leading bytes that cannot start the response are the
    caller's job to strip (see modbus_sync)."""
    if len(buf) < 2:
        return None
    rfc = buf[1]
    if rfc & 0x80:
        return 5
    if rfc in (0x01, 0x02, 0x03, 0x04):
        if len(buf) < 3:
            return None
        return 3 + buf[2] + 2
    if rfc in (0x05, 0x06, 0x0F, 0x10):
        return 8
    return None


def modbus_sync(buf, unit_id, fc):
    """Drop leading bytes until buf starts with <unit_id><fc or fc|0x80>."""
    i = 0
    while i + 1 < len(buf):
        if buf[i] == unit_id and (buf[i + 1] & 0x7F) == fc:
            break
        i += 1
    else:
        # keep a trailing unit_id byte, it may be the start of the frame
        i = len(buf) - 1 if buf and buf[-1] == unit_id else len(buf)
    return buf[i:]


def lux_frame_length(buf):
    """Total length of the Luxpower frame at the start of buf (A1 1A,
    frame_len u16 LE at offset 4, total = frame_len + 6), or None if more
    bytes are needed. A marker with an absurd length is dropped by lux_sync."""
    if len(buf) < 6:
        return None
    return int.from_bytes(buf[4:6], "little") + 6


def lux_sync(buf):
    """Drop leading bytes until buf starts with a plausible A1 1A frame."""
    while True:
        i = buf.find(b"\xA1\x1A")
        if i < 0:
            return buf[-1:] if buf and buf[-1] == 0xA1 else bytearray()
        buf = buf[i:]
        if len(buf) < 6 or 22 <= lux_frame_length(buf) <= 0x2000:
            return buf
        buf = buf[2:]


def lux_matches(frame, request):
    """True when frame answers request: response action, same dev_fn, start
    register and inverter serial. The dongle also pushes unsolicited frames
    over the same characteristic; those do not match and are skipped."""
    return (len(frame) >= 35 and frame[20] == 0x01 and frame[21] == request[21]
            and frame[22:32] == request[22:32] and frame[32:34] == request[32:34])


# ---------------------------------------------------------------------------
# Bluetooth state
# ---------------------------------------------------------------------------

_seen = {}         # address -> (BLEDevice, AdvertisementData, monotonic ts)
_bms = {}          # address -> aiobmsble BMS instance (kept alive)
_gatt = {}         # address -> GattLink


def jbd_write_frame(register, data):
    """JBD write: DD 5A reg len data crc(2, big-endian: 0x10000 - sum) 77."""
    body = bytes([register, len(data)]) + bytes(data)
    crc = (0x10000 - sum(body)) & 0xFFFF
    return b"\xdd\x5a" + body + crc.to_bytes(2, "big") + b"\x77"


def jbd_reply(buf, register):
    """(status, end) for a complete JBD reply to register in buf, else None.
    Reply: DD reg status len data crc(2) 77; status 0 = accepted."""
    start = buf.find(bytes([0xDD, register]))
    if start < 0 or len(buf) < start + 4:
        return None
    end = start + 4 + buf[start + 3] + 3
    if len(buf) < end:
        return None
    if buf[end - 1] != 0x77:
        return (-1, end)
    return (buf[start + 2], end)


def jk_command_frame(cmd, value=b""):
    """JK BLE command (JK02): AA 55 90 EB cmd len value(<=13, zero padded) sum."""
    if len(value) > 13:
        raise HelperError("JK value too long", "bad_request")
    frame = b"\xaa\x55\x90\xeb" + bytes([cmd, len(value)]) + bytes(value) + bytes(13 - len(value))
    return frame + bytes([sum(frame) & 0xFF])


# JK02 registers for the charging / discharging switches (value 1 on, 0 off).
JK_SWITCH_REGISTER = {"charge": 0x1D, "discharge": 0x1E}
JK_SETTLE_S = 1.5  # pause after each JK command (the pack answers with its own frames)
BMS_KINDS = {"jbd_bms": "jbd", "jikong_bms": "jk"}


def _remember(device, adv):
    _seen[device.address.upper()] = (device, adv, time.monotonic())
    if len(_seen) > MAX_DEVICES:
        oldest = sorted(_seen.items(), key=lambda kv: kv[1][2])[: len(_seen) - MAX_DEVICES]
        for addr, _ in oldest:
            _seen.pop(addr, None)


def _map_error(exc):
    """Turn bleak / D-Bus exceptions into a message a user can act on."""
    text = f"{type(exc).__name__}: {exc}"
    low = text.lower()
    if "accessdenied" in low or "access denied" in low or "not allowed to send" in low:
        return HelperError(
            "D-Bus denied access to BlueZ. Allow the container user in the host's BlueZ "
            "D-Bus policy (e.g. add the host 'bluetooth' group via group_add).",
            "dbus_denied",
        )
    if "no such file" in low or "connection refused" in low or ("could not connect" in low and "dbus" in low):
        return HelperError(
            "Cannot reach the system D-Bus. Mount /run/dbus into the container.",
            "no_dbus",
        )
    if "no bluetooth adapters" in low or ("adapter" in low and "not found" in low):
        return HelperError("No Bluetooth adapter found on the host.", "no_adapter")
    if "org.bluez" in low and ("serviceunknown" in low or "not provided" in low):
        return HelperError("BlueZ (bluetoothd) is not running on the host.", "no_bluez")
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return HelperError("Bluetooth operation timed out", "timeout")
    return HelperError(text, "ble_error")


async def cmd_status(_args):
    result = {"dbus_socket": DBUS_SOCKET, "keep_alive": KEEP_ALIVE}
    try:
        import bleak  # noqa: F401
        from importlib.metadata import version
        result["bleak"] = version("bleak")
        result["aiobmsble"] = version("aiobmsble")
    except Exception as exc:  # pragma: no cover - image always has them
        result.update(available=False, error=f"Bluetooth libraries missing: {exc}", code="no_library")
        return result
    try:
        from dbus_fast import BusType, Message
        from dbus_fast.aio import MessageBus

        bus = await asyncio.wait_for(MessageBus(bus_type=BusType.SYSTEM).connect(), 5)
        try:
            reply = await asyncio.wait_for(bus.call(Message(
                destination="org.bluez", path="/", interface="org.freedesktop.DBus.ObjectManager",
                member="GetManagedObjects")), 5)
        finally:
            bus.disconnect()
        if reply.message_type.name == "ERROR":
            raise RuntimeError(f"{reply.error_name}: {reply.body}")
        adapters = []
        for path, ifaces in (reply.body[0] or {}).items():
            a = ifaces.get("org.bluez.Adapter1")
            if a is None:
                continue
            adapters.append({
                "path": path,
                "address": a.get("Address").value if a.get("Address") else None,
                "powered": bool(a.get("Powered").value) if a.get("Powered") else None,
            })
        result["adapters"] = adapters
        result["available"] = any(a.get("powered") for a in adapters)
        if not adapters:
            result.update(error="No Bluetooth adapter found on the host.", code="no_adapter")
        elif not result["available"]:
            result.update(error="Bluetooth adapter is powered off.", code="adapter_off")
    except Exception as exc:
        err = _map_error(exc)
        result.update(available=False, error=str(err), code=err.code)
    return result


async def _identify(device, adv):
    try:
        from aiobmsble.utils import bms_identify
        cls = await bms_identify(adv, device.address)
        return cls
    except Exception:
        log.debug("bms_identify failed for %s", device.address, exc_info=True)
        return None


async def cmd_scan(args):
    from bleak import BleakScanner

    timeout = min(max(float(args.get("timeout", 8)), 1.0), 30.0)
    want_all = bool(args.get("all"))
    found = {}

    def on_adv(device, adv):
        _remember(device, adv)
        found[device.address.upper()] = (device, adv)

    try:
        async with BleakScanner(on_adv):
            await asyncio.sleep(timeout)
    except Exception as exc:
        raise _map_error(exc) from exc

    devices = []
    for addr, (device, adv) in found.items():
        cls = await _identify(device, adv)
        name = adv.local_name or device.name
        devices.append({
            "address": addr,
            "name": name or f"Unknown ({addr[:8]})",
            "rssi": adv.rssi,
            "bms_type": cls.bms_id() if cls else None,
        })
    devices.sort(key=lambda d: (d["bms_type"] is None, -(d["rssi"] or -999)))
    if not want_all:
        bms_only = [d for d in devices if d["bms_type"]]
        # Nothing recognised: return everything so the user can still pick.
        devices = bms_only or devices
    return devices


async def _find(address, timeout):
    """Return (BLEDevice, AdvertisementData) for address, scanning if needed."""
    hit = _seen.get(address)
    if hit and time.monotonic() - hit[2] < SEEN_TTL:
        return hit[0], hit[1]
    from bleak import BleakScanner

    captured = {}

    def match(device, adv):
        if device.address.upper() == address:
            captured["adv"] = adv
            return True
        return False

    try:
        device = await BleakScanner.find_device_by_filter(match, timeout=timeout)
    except Exception as exc:
        raise _map_error(exc) from exc
    if device is None:
        raise HelperError(f"Device {address} not found — is it powered and in range?", "not_found")
    _remember(device, captured["adv"])
    return device, captured["adv"]


async def _drop_bms(address, reset=False):
    bms = _bms.pop(address, None)
    if bms is not None:
        try:
            await bms.disconnect(reset=reset)
        except Exception:
            log.debug("disconnect failed for %s", address, exc_info=True)


async def cmd_read_bms(args):
    address = norm_address(args.get("address"))
    timeout = min(max(float(args.get("timeout", 20)), 5.0), 60.0)
    try:
        async with asyncio.timeout(timeout):
            bms = _bms.get(address)
            if bms is None:
                device, adv = await _find(address, min(10.0, timeout / 2))
                # An explicit type (e.g. "jbd_bms", "jikong_bms") covers rebranded
                # packs whose name / MAC prefix aiobmsble does not recognise.
                forced = str(args.get("bms_type") or "").strip()
                cls = None
                if forced:
                    from aiobmsble.utils import bms_cls
                    if not forced.endswith("_bms") or not forced.replace("_", "").isalnum():
                        raise HelperError(f"unknown BMS type {forced!r}", "bad_request")
                    cls = await bms_cls(forced)
                    if cls is None:
                        raise HelperError(f"unknown BMS type {forced!r}", "bad_request")
                else:
                    cls = await _identify(device, adv)
                if cls is None:
                    raise HelperError(f"{address} is not a recognised Bluetooth BMS — choose its type in the BMS settings", "unsupported")
                from aiobmsble import BMSConfig
                bms = cls(device, BMSConfig(keep_alive=KEEP_ALIVE))
                _bms[address] = bms
                log.info("identified %s as %s", address, cls.bms_id())
            sample = await bms.async_update()
    except HelperError:
        await _drop_bms(address)
        raise
    except Exception as exc:
        # Reset so the next poll starts from a clean connection.
        await _drop_bms(address, reset=True)
        raise _map_error(exc) from exc
    data = flatten_sample(sample)
    if not data:
        raise HelperError("BMS returned no numeric values", "empty")
    data["__kind"] = type(bms).__module__.rsplit(".", 1)[-1]
    return data


class GattLink:
    """A kept-alive GATT connection with one notify characteristic."""

    def __init__(self, client, notify_uuid):
        self.client = client
        self.notify_uuid = notify_uuid
        self.buf = bytearray()
        self.event = asyncio.Event()

    def on_notify(self, _char, data):
        self.buf.extend(data)
        if len(self.buf) > 8192:
            del self.buf[:-8192]
        self.event.set()


async def _drop_gatt(address):
    link = _gatt.pop(address, None)
    if link is not None:
        try:
            await link.client.disconnect()
        except Exception:
            log.debug("gatt disconnect failed for %s", address, exc_info=True)


async def _gatt_link(address, notify_uuid, timeout):
    """Kept-alive connection. notify_uuid=None: plain reads, any open link will do."""
    link = _gatt.get(address)
    if link and link.client.is_connected and (notify_uuid is None or link.notify_uuid == notify_uuid):
        return link
    await _drop_gatt(address)
    device, _adv = await _find(address, min(10.0, timeout / 2))
    from bleak import BleakClient
    from bleak_retry_connector import establish_connection

    client = await establish_connection(
        BleakClient, device, address,
        disconnected_callback=lambda _c: _gatt.pop(address, None),
    )
    link = GattLink(client, notify_uuid)
    if notify_uuid:
        await client.start_notify(notify_uuid, link.on_notify)
    _gatt[address] = link
    return link


async def _exchange(args, framing):
    """Write one request frame, return the matching notified response frame."""
    address = norm_address(args.get("address"))
    write_uuid = str(args.get("write_uuid") or "").strip().lower()
    notify_uuid = str(args.get("notify_uuid") or "").strip().lower()
    if not write_uuid or not notify_uuid:
        raise HelperError("write_uuid and notify_uuid are required", "bad_request")
    try:
        frame = bytes.fromhex(str(args.get("frame") or ""))
    except ValueError as exc:
        raise HelperError("frame must be hex", "bad_request") from exc
    if len(frame) < 4 or len(frame) > 256:
        raise HelperError("frame length out of range", "bad_request")
    if framing == "luxpower" and (len(frame) < 36 or frame[:2] != b"\xA1\x1A"):
        raise HelperError("not a Luxpower request frame", "bad_request")
    timeout = min(max(float(args.get("timeout", 15)), 2.0), 60.0)
    unit_id, fc = frame[0], frame[1]

    try:
        async with asyncio.timeout(timeout):
            link = await _gatt_link(address, notify_uuid, timeout)
            link.buf.clear()
            link.event.clear()
            # Luxpower requests exceed the default 20-byte payload; BlueZ sends
            # them as one long write, which the dongle reassembles.
            await link.client.write_gatt_char(write_uuid, frame, response=framing == "luxpower" or None)
            while True:
                await link.event.wait()
                link.event.clear()
                if framing == "luxpower":
                    resp = None
                    while True:
                        link.buf[:] = lux_sync(link.buf)
                        need = lux_frame_length(link.buf)
                        if need is None or len(link.buf) < need:
                            break
                        candidate = bytes(link.buf[:need])
                        del link.buf[:need]
                        if lux_matches(candidate, frame):
                            resp = candidate
                            break
                    if resp is not None:
                        break
                    continue
                synced = modbus_sync(link.buf, unit_id, fc)
                if len(synced) != len(link.buf):
                    link.buf[:] = synced
                need = modbus_frame_length(link.buf, unit_id, fc)
                if need is not None and len(link.buf) >= need:
                    resp = bytes(link.buf[:need])
                    del link.buf[:need]
                    break
    except HelperError:
        raise
    except Exception as exc:
        await _drop_gatt(address)
        raise _map_error(exc) from exc
    if not KEEP_ALIVE:
        await _drop_gatt(address)
    return {"frame": resp.hex()}


async def cmd_modbus(args):
    return await _exchange(args, "modbus")


async def cmd_luxpower(args):
    return await _exchange(args, "luxpower")


def full_uuid(u):
    """'2a03' / '0x2a03' / full form -> lower-case 128-bit UUID string."""
    u = str(u or "").strip().lower()
    if u.startswith("0x"):
        u = u[2:]
    if len(u) == 4 and all(c in "0123456789abcdef" for c in u):
        return f"0000{u}-0000-1000-8000-00805f9b34fb"
    if len(u) == 36:
        return u
    raise HelperError(f"invalid UUID {u!r}", "bad_request")


async def cmd_gatt_read(args):
    """Read characteristics by (service, characteristic). Never writes.
    The service is part of the key because some devices reuse standard
    characteristic UUIDs in several services."""
    address = norm_address(args.get("address"))
    reads = args.get("reads") or []
    if not isinstance(reads, list) or not reads or len(reads) > 32:
        raise HelperError("reads must be a list of 1-32 {service, characteristic}", "bad_request")
    wanted = [(full_uuid(r.get("service")), full_uuid(r.get("characteristic"))) for r in reads]
    timeout = min(max(float(args.get("timeout", 20)), 3.0), 60.0)
    values = []
    try:
        async with asyncio.timeout(timeout):
            link = await _gatt_link(address, None, timeout)
            client = link.client
            for svc_uuid, char_uuid in wanted:
                svc = client.services.get_service(svc_uuid)
                ch = svc.get_characteristic(char_uuid) if svc else None
                if ch is None:
                    values.append(None)
                    continue
                values.append(bytes(await client.read_gatt_char(ch)).hex())
    except HelperError:
        raise
    except Exception as exc:
        await _drop_gatt(address)
        raise _map_error(exc) from exc
    if all(v is None for v in values):
        raise HelperError("none of the requested characteristics exist on this device", "unsupported")
    if not KEEP_ALIVE:
        await _drop_gatt(address)
    return {"values": values}


async def _bms_kind(address, forced, timeout):
    """'jbd' / 'jk' for a pack: its set type, else the type polling identified."""
    forced = str(forced or "").strip()
    module = forced
    if not module:
        bms = _bms.get(address)
        if bms is not None:
            module = type(bms).__module__.rsplit(".", 1)[-1]
        else:
            device, adv = await _find(address, min(10.0, timeout / 2))
            cls = await _identify(device, adv)
            module = cls.__module__.rsplit(".", 1)[-1] if cls else ""
    kind = BMS_KINDS.get(module)
    if kind is None:
        raise HelperError(f"Switching charging or discharging is available for JBD and JK packs only (this one is {module or 'unknown'})", "unsupported")
    return kind


async def cmd_bms_switch(args):
    """Turn charging or discharging on/off on a JBD or JK pack. The pack's
    aiobmsble connection is dropped first (one link per device); the next poll
    reconnects and shows the new state, which the caller checks."""
    address = norm_address(args.get("address"))
    which = args.get("switch")
    if which not in ("charge", "discharge"):
        raise HelperError("switch must be charge or discharge", "bad_request")
    if not isinstance(args.get("on"), bool):
        raise HelperError("on must be true or false", "bad_request")
    on = args["on"]
    timeout = min(max(float(args.get("timeout", 25)), 5.0), 60.0)
    try:
        async with asyncio.timeout(timeout):
            kind = await _bms_kind(address, args.get("bms_type"), timeout)
            await _drop_bms(address)
            if kind == "jbd":
                charge_on = on if which == "charge" else args.get("charge_on")
                discharge_on = on if which == "discharge" else args.get("discharge_on")
                if not isinstance(charge_on, bool) or not isinstance(discharge_on, bool):
                    raise HelperError("the other switch's current state is required", "bad_request")
                # MOS control 0xE1: bit 0 set = charging off, bit 1 set = discharging off.
                mask = (0 if charge_on else 1) | (0 if discharge_on else 2)
                link = await _gatt_link(address, full_uuid("ff01"), timeout)
                link.buf.clear()
                link.event.clear()
                await link.client.write_gatt_char(full_uuid("ff02"), jbd_write_frame(0xE1, bytes([0, mask])), response=None)
                status = None
                while status is None:
                    await link.event.wait()
                    link.event.clear()
                    # Everything already received, frame by frame.
                    while (got := jbd_reply(link.buf, 0xE1)) is not None:
                        code, end = got
                        del link.buf[:end]
                        if code != -1:  # -1: damaged frame, look at the next one
                            status = code
                            break
                if status != 0:
                    raise HelperError("The BMS refused the change", "refused")
            else:
                link = await _gatt_link(address, full_uuid("ffe1"), timeout)
                # Ask for device info first (the JK app does too); then write the switch.
                await link.client.write_gatt_char(full_uuid("ffe1"), jk_command_frame(0x97), response=None)
                await asyncio.sleep(JK_SETTLE_S)
                value = (1 if on else 0).to_bytes(4, "little")
                await link.client.write_gatt_char(full_uuid("ffe1"), jk_command_frame(JK_SWITCH_REGISTER[which], value), response=None)
                await asyncio.sleep(JK_SETTLE_S)
    except HelperError:
        await _drop_gatt(address)
        raise
    except Exception as exc:
        await _drop_gatt(address)
        raise _map_error(exc) from exc
    await _drop_gatt(address)
    return {"kind": kind}


async def cmd_disconnect(args):
    address = norm_address(args.get("address"))
    await _drop_bms(address)
    await _drop_gatt(address)
    return True


async def cmd_disconnect_all(_args):
    for address in list(_bms):
        await _drop_bms(address)
    for address in list(_gatt):
        await _drop_gatt(address)
    return True


COMMANDS = {
    "status": cmd_status,
    "scan": cmd_scan,
    "read_bms": cmd_read_bms,
    "modbus": cmd_modbus,
    "luxpower": cmd_luxpower,
    "gatt_read": cmd_gatt_read,
    "bms_switch": cmd_bms_switch,
    "disconnect": cmd_disconnect,
    "disconnect_all": cmd_disconnect_all,
}


def _emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


async def _handle(line):
    try:
        req = json.loads(line)
    except ValueError:
        _emit({"id": None, "ok": False, "error": "invalid JSON", "code": "bad_request"})
        return
    rid = req.get("id")
    fn = COMMANDS.get(req.get("cmd"))
    if fn is None:
        _emit({"id": rid, "ok": False, "error": f"unknown command {req.get('cmd')!r}", "code": "bad_request"})
        return
    try:
        result = await fn(req.get("args") or {})
        _emit({"id": rid, "ok": True, "result": result})
    except HelperError as exc:
        _emit({"id": rid, "ok": False, "error": str(exc), "code": exc.code})
    except Exception as exc:
        log.exception("command %s failed", req.get("cmd"))
        err = _map_error(exc)
        _emit({"id": rid, "ok": False, "error": str(err), "code": err.code})


async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    _emit({"event": "ready", "pid": os.getpid(), "keep_alive": KEEP_ALIVE})
    try:
        while True:
            line = await reader.readline()
            if not line:
                break  # parent closed stdin
            line = line.strip()
            if line:
                await _handle(line)  # strictly one command at a time
    finally:
        await cmd_disconnect_all({})


def _self_test():
    assert norm_address("aa:bb:cc:dd:ee:ff") == "AA:BB:CC:DD:EE:FF"
    for bad in ("", "aa:bb", "zz:bb:cc:dd:ee:ff", None):
        try:
            norm_address(bad)
        except HelperError:
            pass
        else:
            raise AssertionError(f"accepted {bad!r}")
    flat = flatten_sample({
        "voltage": 52.1, "current": -3.2, "battery_level": 87, "battery_charging": False,
        "cell_voltages": [3.3, 3.31], "temp_values": [21.5], "problem": True,
        "packs": [{"voltage": 26.0, "cell_voltages": [3.2]}], "name": "x", "nan": float("nan"),
    })
    assert flat == {
        "voltage": 52.1, "current": -3.2, "battery_level": 87, "battery_charging": 0,
        "cell_voltage_1": 3.3, "cell_voltage_2": 3.31, "temp_1": 21.5, "problem": 1,
        "pack_1_voltage": 26.0, "pack_1_cell_voltage_1": 3.2,
    }, flat
    # read response: 01 03 04 <4 data bytes> crc crc
    assert modbus_frame_length(bytearray(b"\x01\x03"), 1, 3) is None
    assert modbus_frame_length(bytearray(b"\x01\x03\x04"), 1, 3) == 9
    assert modbus_frame_length(bytearray(b"\x01\x83\x02"), 1, 3) == 5
    assert modbus_frame_length(bytearray(b"\x01\x06"), 1, 6) == 8
    assert modbus_sync(bytearray(b"\x00\x99\x01\x03\x02"), 1, 3) == bytearray(b"\x01\x03\x02")
    assert modbus_sync(bytearray(b"\x00\x99\x01"), 1, 3) == bytearray(b"\x01")
    assert modbus_sync(bytearray(b"\x00\x99"), 1, 3) == bytearray()
    req = bytes.fromhex("a11a0500200001c244543632303030353735120000043632303033553232373100002800b019")
    resp = bytes.fromhex("a11a05006f0001c20000000000000000000061000104363230303355323237310000" "50" + "00" * 80 + "0000")
    assert lux_frame_length(bytearray(resp)) == len(resp) and lux_matches(resp, req)
    push = resp[:21] + b"\x03" + resp[22:]
    assert not lux_matches(push, req)
    assert lux_sync(bytearray(b"\x00\x01" + resp[:10])) == bytearray(resp[:10])
    assert lux_sync(bytearray(b"\x00\xa1")) == bytearray(b"\xa1")
    assert lux_sync(bytearray(b"\xa1\x1a\x05\x00\xff\xff" + resp)) == bytearray(resp)
    # JBD MOS control, all on: the well-known DD 5A E1 02 00 00 FF 1D 77
    assert jbd_write_frame(0xE1, b"\x00\x00").hex() == "dd5ae1020000ff1d77"
    assert jbd_write_frame(0xE1, b"\x00\x02").hex() == "dd5ae1020002ff1b77"
    assert jbd_reply(bytearray.fromhex("00dde10000ffff77"), 0xE1) == (0, 8)
    assert jbd_reply(bytearray.fromhex("dde10000ffff00"), 0xE1) == (-1, 7)  # bad tail
    assert jbd_reply(bytearray.fromhex("dde18000ff8077"), 0xE1) == (0x80, 7)
    assert jbd_reply(bytearray.fromhex("dde100"), 0xE1) is None
    # JK device-info request: AA 55 90 EB 97 00 ... 11
    assert jk_command_frame(0x97).hex() == "aa5590eb97" + "00" * 14 + "11"
    f = jk_command_frame(0x1D, (1).to_bytes(4, "little"))
    assert len(f) == 20 and f[4] == 0x1D and f[5] == 4 and f[6:10] == b"\x01\x00\x00\x00" and f[-1] == sum(f[:-1]) & 0xFF
    _self_test_bms_switch()
    assert full_uuid("2A03") == "00002a03-0000-1000-8000-00805f9b34fb"
    assert full_uuid("0x1810") == "00001810-0000-1000-8000-00805f9b34fb"
    print("ok")


def _self_test_bms_switch():
    """cmd_bms_switch against a fake GATT link: the frames it writes, and how
    it treats the JBD reply (accepted, refused, damaged then accepted)."""
    g = globals()
    saved = {k: g[k] for k in ("_gatt_link", "_drop_gatt", "_drop_bms", "_bms_kind", "JK_SETTLE_S")}
    g["JK_SETTLE_S"] = 0

    class Client:
        def __init__(self, link, replies):
            self.link, self.replies, self.writes = link, list(replies), []

        async def write_gatt_char(self, uuid, data, response=None):
            self.writes.append((uuid, bytes(data).hex()))
            if self.replies:
                self.link.on_notify(None, bytes.fromhex(self.replies.pop(0)))

    def run(kind, args, replies=()):
        link = GattLink(None, "notify")
        link.client = Client(link, replies)
        dropped = []

        async def fake_link(_a, _n, _t):
            return link

        async def fake_drop(address, reset=False):
            dropped.append(address)

        async def fake_kind(_a, _f, _t):
            return kind

        g.update(_gatt_link=fake_link, _drop_gatt=fake_drop, _drop_bms=fake_drop, _bms_kind=fake_kind, JK_SETTLE_S=0)
        try:
            result = asyncio.run(cmd_bms_switch({"address": "aa:bb:cc:00:00:01", "timeout": 5, **args}))
            return result, link.client.writes, dropped, None
        except HelperError as exc:
            return None, link.client.writes, dropped, exc
        finally:
            g.update(saved)

    ff02, ffe1 = full_uuid("ff02"), full_uuid("ffe1")
    # JBD: charging off, discharging stays on -> mask 0x01; reply accepted
    res, writes, dropped, err = run("jbd", {"switch": "charge", "on": False, "charge_on": True, "discharge_on": True}, ["dde10000ffff77"])
    assert err is None and res == {"kind": "jbd"}, err
    assert writes == [(ff02, jbd_write_frame(0xE1, b"\x00\x01").hex())], writes
    assert "AA:BB:CC:00:00:01" in dropped  # the aiobmsble link is released first
    # JBD: discharging off while charging is already off -> mask 0x03
    _, writes, _, err = run("jbd", {"switch": "discharge", "on": False, "charge_on": False, "discharge_on": True}, ["dde10000ffff77"])
    assert err is None and writes[0][1] == jbd_write_frame(0xE1, b"\x00\x03").hex()
    # JBD refuses (status 0x80)
    _, _, _, err = run("jbd", {"switch": "charge", "on": True, "charge_on": False, "discharge_on": True}, ["dde18000ff8077"])
    assert err is not None and err.code == "refused"
    # damaged frame first, then the real reply
    _, _, _, err = run("jbd", {"switch": "charge", "on": True, "charge_on": False, "discharge_on": True}, ["dde10000ffff00dde10000ffff77"])
    assert err is None, err
    # JBD without the other switch's state: refused before anything is written
    _, writes, _, err = run("jbd", {"switch": "charge", "on": True}, [])
    assert err is not None and err.code == "bad_request" and writes == []
    # JK: device info first, then register 0x1E (discharging) = 0
    res, writes, _, err = run("jk", {"switch": "discharge", "on": False}, [])
    assert err is None and res == {"kind": "jk"}
    assert writes == [(ffe1, jk_command_frame(0x97).hex()), (ffe1, jk_command_frame(0x1E, bytes(4)).hex())], writes
    _, writes, _, _ = run("jk", {"switch": "charge", "on": True}, [])
    assert writes[1][1] == jk_command_frame(0x1D, b"\x01\x00\x00\x00").hex()
    # bad requests
    for bad in ({"switch": "balance", "on": True}, {"switch": "charge", "on": "yes"}, {"switch": "charge"}):
        _, writes, _, err = run("jk", bad, [])
        assert err is not None and err.code == "bad_request" and writes == [], bad


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        _self_test()
        sys.exit(0)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
