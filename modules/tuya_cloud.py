#!/usr/bin/env python3
"""
Tuya Cloud API bridge — Smart Life OAuth flow via tuya_sharing.Manager.
No IoT Platform API keys needed — just scan a QR code with the Smart Life app.
"""
import json
import sys

CLIENT_ID = "HA_3y9q4ak7g4ephrvke"
SCHEMA = "smartlife"


def generate_qr(uid):
    from tuya_sharing import LoginControl
    lc = LoginControl()
    result = lc.qr_code(CLIENT_ID, SCHEMA, str(uid))
    if not result.get("success"):
        print(json.dumps({"error": result.get("msg", "Failed"), "code": result.get("code", "")}))
        sys.exit(1)
    qr_token = result.get("result", {}).get("qrcode", "")
    print(json.dumps({"qr_token": qr_token, "qr_url": f"tuyaSmart--qrLogin?token={qr_token}"}))


def poll_login(qr_token, uid):
    from tuya_sharing import LoginControl
    lc = LoginControl()
    success, result = lc.login_result(qr_token, CLIENT_ID, str(uid))
    if not success:
        code = result.get("code", "")
        if code == "QRCODE_EXPIRE":
            print(json.dumps({"status": "expired"}))
        elif code == "QRCODE_NOT_SCANNED":
            print(json.dumps({"status": "waiting"}))
        else:
            print(json.dumps({"status": "error", "error": result.get("msg", ""), "code": code}))
        sys.exit(1)
    # Return all fields Manager needs
    print(json.dumps({
        "status": "ok",
        "access_token": result.get("access_token", ""),
        "refresh_token": result.get("refresh_token", ""),
        "expire_time": result.get("expire_time", 0),
        "uid": result.get("uid", ""),
        "username": result.get("username", ""),
        "endpoint": result.get("endpoint", "https://openapi.tuyaeu.com"),
        "t": result.get("t", 0),
        "terminal_id": result.get("terminal_id", ""),
        "country_code": result.get("country_code", ""),
    }))


def fetch_devices_oauth(token_info_json):
    """Use tuya_sharing.Manager to fetch all devices — the correct API for OAuth tokens."""
    from tuya_sharing import Manager, SharingTokenListener

    token_info = json.loads(token_info_json)

    # DEBUG: print key fields (to stderr so it appears in docker logs)
    import sys
    print(f"[tuya_cloud DEBUG] token_info keys: {list(token_info.keys())}", file=sys.stderr)
    print(f"[tuya_cloud DEBUG] access_token present: {bool(token_info.get('access_token'))}", file=sys.stderr)
    print(f"[tuya_cloud DEBUG] refresh_token present: {bool(token_info.get('refresh_token'))}", file=sys.stderr)
    print(f"[tuya_cloud DEBUG] uid: {token_info.get('uid', 'N/A')}", file=sys.stderr)
    print(f"[tuya_cloud DEBUG] endpoint: {token_info.get('endpoint', 'N/A')}", file=sys.stderr)

    # Dummy token listener (we don't persist tokens)
    class _L(SharingTokenListener):
        def update_token(self, token_info):
            pass

    manager = Manager(
        CLIENT_ID,
        token_info.get("uid", ""),
        token_info.get("terminal_id", ""),
        token_info.get("endpoint", "https://openapi.tuyaeu.com"),
        token_info,
        _L(),
    )

    try:
        # Monkey-patch to dump raw homes response
        orig_get = manager.customer_api.get
        def _patched_get(path, params=None):
            result = orig_get(path, params=params)
            if 'homes' in path:
                print(f"[tuya_cloud DEBUG] RAW homes response: {json.dumps(result)[:500]}", file=sys.stderr)
            return result
        manager.customer_api.get = _patched_get
        
        # Fetch full device specifications to get DP labels (device.function)
        # device.function is already in the initial homes response — per-device
        # spec calls are slow and unnecessary for DP labels
        manager.device_repository.update_device_specification = lambda d: None
        manager.device_repository.update_device_strategy_info = lambda d: None
        manager.device_repository.update_device_report_type = lambda d: None
        
        manager.update_device_cache()
    except Exception as e:
        print(f"[tuya_cloud ERROR] update_device_cache failed: {e}", file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    print(f"[tuya_cloud DEBUG] homes found: {len(manager.user_homes)}", file=sys.stderr)
    for h in manager.user_homes:
        print(f"[tuya_cloud DEBUG]   home: id={h.id} name={h.name}", file=sys.stderr)
    print(f"[tuya_cloud DEBUG] devices in map: {len(manager.device_map)}", file=sys.stderr)

    devices = []
    for device_id, device in manager.device_map.items():
        obj = {
            "name": device.name,
            "id": device.id,
            "key": device.local_key,
            "ip": device.ip or "",
            "mac": getattr(device, "mac", "") or "",
            "version": "",
            "product_name": device.product_name or "",
            "category": device.category or "",
            "mapping": {},
        }
        # Build DP name mapping from device.function
        if device.function:
            for dp_id, fn in device.function.items():
                # DeviceFunction fields: desc (human-readable), name, code — pick best
                label = getattr(fn, 'desc', None) or getattr(fn, 'name', None) or getattr(fn, 'code', '') or ''
                if label:
                    obj["mapping"][str(dp_id)] = label
        devices.append(obj)

    print(json.dumps(devices))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: tuya_cloud.py <action> [args...]"}))
        sys.exit(1)

    action = sys.argv[1]

    if action == "generate-qr":
        if len(sys.argv) != 3:
            print(json.dumps({"error": "Usage: generate-qr <uid>"}))
            sys.exit(1)
        generate_qr(sys.argv[2])

    elif action == "poll-login":
        if len(sys.argv) != 4:
            print(json.dumps({"error": "Usage: poll-login <qr_token> <uid>"}))
            sys.exit(1)
        poll_login(sys.argv[2], sys.argv[3])

    elif action == "fetch-devices-oauth":
        if len(sys.argv) != 3:
            print(json.dumps({"error": "Usage: fetch-devices-oauth <token_info_json>"}))
            sys.exit(1)
        fetch_devices_oauth(sys.argv[2])

    else:
        print(json.dumps({"error": f"Unknown action: {action}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
