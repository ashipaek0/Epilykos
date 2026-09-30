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
  read_bms    {address, timeout}             one aiobmsble sample, flattened to numbers
  modbus      {address, write_uuid, notify_uuid, frame, timeout}
                              send one Modbus-RTU frame over a GATT write/notify
                              pair and return the complete response frame (hex)
  gatt_read   {address, reads: [{service, characteristic}], timeout}
                              read characteristics (read-only devices that expose
                              live values directly, e.g. Phocos Any-Grid)
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


# ---------------------------------------------------------------------------
# Bluetooth state
# ---------------------------------------------------------------------------

_seen = {}         # address -> (BLEDevice, AdvertisementData, monotonic ts)
_bms = {}          # address -> aiobmsble BMS instance (kept alive)
_gatt = {}         # address -> GattLink


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
                cls = await _identify(device, adv)
                if cls is None:
                    raise HelperError(f"{address} is not a supported Bluetooth BMS", "unsupported")
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
        if len(self.buf) > 4096:
            del self.buf[:-4096]
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


async def cmd_modbus(args):
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
    timeout = min(max(float(args.get("timeout", 15)), 2.0), 60.0)
    unit_id, fc = frame[0], frame[1]

    try:
        async with asyncio.timeout(timeout):
            link = await _gatt_link(address, notify_uuid, timeout)
            link.buf.clear()
            link.event.clear()
            await link.client.write_gatt_char(write_uuid, frame)
            while True:
                await link.event.wait()
                link.event.clear()
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
    "gatt_read": cmd_gatt_read,
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
    assert full_uuid("2A03") == "00002a03-0000-1000-8000-00805f9b34fb"
    assert full_uuid("0x1810") == "00001810-0000-1000-8000-00805f9b34fb"
    print("ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        _self_test()
        sys.exit(0)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
