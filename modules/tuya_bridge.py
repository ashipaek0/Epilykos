#!/usr/bin/env python3
"""
Tuya LAN device bridge — called by Epilykos (Node.js) via child_process.execFile.
Polls DP values from a Tuya device on the LAN or tests connectivity.
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


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: tuya_bridge.py <poll|test> <dev_id> <address> <local_key> <version>"
        }))
        sys.exit(1)

    action = sys.argv[1]

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
