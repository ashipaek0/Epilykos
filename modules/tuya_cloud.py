#!/usr/bin/env python3
"""
Tuya Cloud API bridge — called by Epilykos (Node.js) via child_process.execFile.
Uses the Tuya Home API (openapi.tuya{region}.com) — NO IoT subscription needed.
Fetches all devices for a given user_id (Smart Life UID) with local keys + DP mappings.
"""
import json
import sys

DEVICE_FIELDS = [
    "name", "id", "key", "ip", "mac", "version",
    "product_name", "category", "mapping"
]


def fetch_devices(region, access_id, access_secret, user_id):
    """Connect to Tuya Home API and return all devices with local keys."""
    from tinytuya import Cloud

    c = Cloud(
        apiRegion=region,
        apiKey=access_id,
        apiSecret=access_secret,
    )

    # Call the Home API: /v1.0/users/{uid}/devices
    uri = "users/%s/devices" % user_id
    result = c.cloudrequest(uri)

    if not result or not result.get("success"):
        error = (result or {}).get("msg", "Unknown error")
        print(json.dumps({"error": error}))
        sys.exit(1)

    devices = result.get("result", [])

    # Enrich with detailed device info (mapping, local_key if missing)
    cleaned = []
    for dev in devices:
        obj = {}
        # Map Home API response fields to our standard format
        obj["name"] = dev.get("name", "")
        obj["id"] = dev.get("id", "")
        obj["key"] = dev.get("local_key", "")
        obj["ip"] = dev.get("ip", "")
        obj["mac"] = dev.get("mac", "")
        obj["version"] = ""
        obj["product_name"] = dev.get("product_name", dev.get("category_name", ""))
        obj["category"] = dev.get("category", "")

        # Try to get DP mapping for this device
        try:
            dev_id = obj["id"]
            if dev_id:
                mapping = c.getmapping(dev_id)
                if mapping and isinstance(mapping, dict):
                    obj["mapping"] = mapping
                else:
                    obj["mapping"] = {}
        except Exception:
            obj["mapping"] = {}

        cleaned.append(obj)

    print(json.dumps(cleaned))


def main():
    if len(sys.argv) < 6:
        print(json.dumps({
            "error": "Usage: tuya_cloud.py fetch-devices <region> <access_id> <access_secret> <user_id>"
        }))
        sys.exit(1)

    action = sys.argv[1]
    if action != "fetch-devices":
        print(json.dumps({"error": f"Unknown action: {action}"}))
        sys.exit(1)

    region, access_id, access_secret, user_id = sys.argv[2:6]

    try:
        fetch_devices(region, access_id, access_secret, user_id)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
