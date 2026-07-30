#!/usr/bin/env python3
"""
Tuya LAN device bridge — called by Epilykos (Node.js) via child_process.execFile.
Polls DP values, tests connectivity, and discovers devices on a subnet.
"""

import json
import sys


def _make_device(dev_id, address, local_key, version):
    """Create and configure a tinytuya Device instance."""
    from tinytuya import Device  # noqa: E402 — lazy import for error handling

    d = Device(dev_id, address, local_key)
    d.set_version(float(version))
    d.set_socketTimeout(5)
    return d


def poll_device(dev_id, address, local_key, version):
    """Return raw DP → value map (e.g. {"1": 85, "2": 230})."""
    d = _make_device(dev_id, address, local_key, version)
    dps = d.status().get("dps", {})
    print(json.dumps(dps))


def test_device(dev_id, address, local_key, version):
    """Probe a device and return success + DPs or an error."""
    try:
        d = _make_device(dev_id, address, local_key, version)
        result = d.status()
        dps = result.get("dps", {})
        print(json.dumps({"success": True, "dps": dps}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


def discover_subnet(subnet):
    """
    Discover Tuya devices by scanning every IP in a subnet range.
    Works across routed subnets — no broadcast required.

    Uses tinytuya's device discovery on port 6668 (TCP) for each IP.
    Only needs an IP — no local_key or dev_id.
    """
    import ipaddress
    import socket
    from concurrent.futures import ThreadPoolExecutor, as_completed

    try:
        network = ipaddress.ip_network(subnet, strict=False)
    except ValueError as e:
        print(json.dumps({"error": f"Invalid subnet: {e}"}))
        sys.exit(1)

    # Limit to /24 or smaller to avoid massive scans
    if network.prefixlen < 16:
        print(json.dumps({"error": "Subnet too large — use /16 or smaller"}))
        sys.exit(1)

    hosts = list(network.hosts())
    if len(hosts) > 1024:
        print(json.dumps({"error": f"Subnet has {len(hosts)} hosts — max 1024 for scanning"}))
        sys.exit(1)

    found = []

    # Use tinytuya's built-in scanner with forcescan to probe the entire subnet
    # in a single call — tinytuya handles threading internally.
    try:
        from tinytuya.scanner import devices as scan_devices
        # Build list of all IP strings in the subnet
        ip_list = [str(ip) for ip in hosts]
        result = scan_devices(
            verbose=False,
            scantime=8,           # seconds to wait for responses
            poll=False,           # don't try to query DPs (needs keys)
            discover=False,       # don't listen for unsolicited broadcasts
            forcescan=ip_list,    # force-scan every IP in the subnet
            assume_yes=True
        )
        if result:
            for dev in result.values():
                found.append({
                    "dev_id": dev.get("gwId", ""),
                    "ip": dev.get("ip", ""),
                    "version": dev.get("version", "3.3"),
                    "dps_count": 0
                })
    except Exception as e:
        print(json.dumps({"error": f"Scan failed: {e}"}))
        sys.exit(1)

    # Sort by IP
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
