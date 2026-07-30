#!/usr/bin/env python3
"""
Tuya Cloud API bridge — called by Epilykos (Node.js) via child_process.execFile.
Fetches devices + local keys + DP name mappings from Tuya Cloud.
"""

import json
import sys

DEVICE_FIELDS = [
    "name", "id", "key", "ip", "mac", "version",
    "product_name", "category", "mapping"
]


def fetch_devices(region, access_id, access_secret, device_id):
    """Connect to Tuya Cloud and return devices with local keys + DPs."""
    from tinytuya import Cloud  # noqa: E402 — lazy import for error handling

    c = Cloud(apiRegion=region, apiKey=access_id, apiSecret=access_secret,
              apiDeviceID=device_id)

    devices = c.getdevices(include_map=True)

    cleaned = []
    for d in devices:
        obj = {}
        for field in DEVICE_FIELDS:
            val = d.get(field)
            if val is None:
                val = ""
            obj[field] = val
        cleaned.append(obj)

    print(json.dumps(cleaned))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: tuya_cloud.py fetch-devices <region> <access_id> <access_secret> <device_id>"
        }))
        sys.exit(1)

    action = sys.argv[1]

    if action != "fetch-devices":
        print(json.dumps({"error": f"Unknown action: {action}"}))
        sys.exit(1)

    if len(sys.argv) != 6:
        print(json.dumps({
            "error": "Usage: tuya_cloud.py fetch-devices <region> <access_id> <access_secret> <device_id>"
        }))
        sys.exit(1)

    region, access_id, access_secret, device_id = sys.argv[2:6]

    try:
        fetch_devices(region, access_id, access_secret, device_id)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
