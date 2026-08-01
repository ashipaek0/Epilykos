#!/usr/bin/env python3
"""
Tuya LAN device bridge — called by Epilykos (Node.js) via child_process.execFile.
Polls DP values, tests connectivity, and discovers devices on a subnet.
"""
import json
import os
import struct
import sys

DEFAULT_TIMEOUT = int(os.getenv("TUYA_LAN_TIMEOUT", "5"))


def _make_device(dev_id, address, local_key, version):
    from tinytuya import Device
    d = Device(dev_id, address, local_key)
    d.set_version(float(version))
    d.set_socketTimeout(DEFAULT_TIMEOUT)
    return d


def poll_device(dev_id, address, local_key, version):
    """Return raw DP → value map (e.g. {"1": 85, "2": 230})."""
    d = _make_device(dev_id, address, local_key, version)
    d.set_socketTimeout(DEFAULT_TIMEOUT)
    try:
        dps = d.status().get("dps", {})
        print(json.dumps(dps))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def test_device(dev_id, address, local_key, version):
    """Probe a device and return success + DPs or an error."""
    try:
        d = _make_device(dev_id, address, local_key, version)
        d.set_socketTimeout(DEFAULT_TIMEOUT)
        result = d.status()
        dps = result.get("dps", {})
        print(json.dumps({"success": True, "dps": dps}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


def discover_subnet(subnet):
    """
    Quick TCP port-6668 scan of a subnet. Connects and immediately sends RST
    — no recv(), no banner. Just checks which IPs accept TCP on the Tuya port.
    Safe for cross-subnet use: 15 workers, 0.3s timeout, RST cleanup.
    """
    import ipaddress
    import socket
    import time
    from concurrent.futures import ThreadPoolExecutor, as_completed

    try:
        network = ipaddress.ip_network(subnet, strict=False)
    except ValueError as e:
        print(json.dumps({"error": f"Invalid subnet: {e}"}))
        sys.exit(1)

    hosts = list(network.hosts())
    if len(hosts) > 1024:
        print(json.dumps({"error": f"Subnet has {len(hosts)} hosts — max 1024"}))
        sys.exit(1)

    MAX_DISCOVER_RESULTS = int(os.getenv("TUYA_MAX_DISCOVER_RESULTS", "100"))

    def probe_ip(ip_str):
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                            struct.pack('ii', 1, 0))
            sock.settimeout(0.3)
            sock.connect((ip_str, 6668))
            # Connected — Tuya device present. RST immediately (SO_LINGER).
            sock.close()
            return ip_str
        except Exception:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass
            return None

    found = []
    with ThreadPoolExecutor(max_workers=15) as ex:
        futures = {}
        for i, ip in enumerate(hosts):
            futures[ex.submit(probe_ip, str(ip))] = str(ip)
            if i % 10 == 9:
                time.sleep(0.05)
        for future in as_completed(futures):
            result = future.result()
            if result:
                found.append({
                    "dev_id": "",
                    "ip": result,
                    "version": "?",
                    "dps_count": 0,
                })
            if len(found) >= MAX_DISCOVER_RESULTS:
                break

    found.sort(key=lambda d: [int(o) for o in d["ip"].split(".")])
    print(json.dumps(found))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: tuya_bridge.py <poll|test|discover> [args...]"
        }))
        sys.exit(1)

    action = sys.argv[1]

    if action == "discover":
        if len(sys.argv) != 3:
            print(json.dumps({"error": "Usage: tuya_bridge.py discover <subnet>"}))
            sys.exit(1)
        try:
            discover_subnet(sys.argv[2])
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)
        return

    if action not in ("poll", "test"):
        print(json.dumps({"error": f"Unknown action: {action}"}))
        sys.exit(1)

    if len(sys.argv) != 6:
        print(json.dumps({
            "error": f"Usage: tuya_bridge.py {action} <dev_id> <address> <local_key> <version>"
        }))
        sys.exit(1)

    dev_id, address, local_key, version = sys.argv[2:6]

    try:
        if action == "poll":
            poll_device(dev_id, address, local_key, version)
        else:
            test_device(dev_id, address, local_key, version)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
