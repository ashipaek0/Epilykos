#!/usr/bin/env python3
"""
Import existing Tuya device configs from Home Assistant's tuya_local integration.
Reads HA's core.config_entries, extracts device_id/host/key/version, outputs JSON.
"""
import json
import sys


def main():
    ha_config = "/home/ashipa/docker/ha/config/.storage/core.config_entries"
    try:
        with open(ha_config) as f:
            data = json.load(f)
    except FileNotFoundError:
        print(json.dumps({"error": "HA config not found at " + ha_config}))
        sys.exit(1)

    devices = []
    for entry in data.get("data", {}).get("entries", []):
        if entry.get("domain") != "tuya_local":
            continue
        d = entry.get("data", {})
        devices.append({
            "name": entry.get("title", ""),
            "dev_id": d.get("device_id", ""),
            "address": d.get("host", ""),
            "local_key": d.get("local_key", ""),
            "version": str(d.get("protocol_version", "3.3")),
            "enabled": True,
            "poll_interval": 30,
            "dps": {},
            "dpNames": {},
        })

    print(json.dumps(devices))


if __name__ == "__main__":
    main()
