"""
Bluetooth BMS Bridge for Epilykos Dashboard
Uses bleak for scanning, aiobmsble v0.25+ for reading.
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
import asyncio
import logging
import os
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bms-bridge")

BMS_ALLOW_ORIGINS = os.getenv("BMS_ALLOW_ORIGINS", "https://epilykos.nousresearch.com")
BLE_SCAN_TIMEOUT = float(os.getenv("BLE_SCAN_TIMEOUT", "10.0"))
MAX_RESPONSE_BYTES = int(os.getenv("BMS_MAX_RESPONSE_BYTES", str(1024 * 1024)))  # 1 MB

discovered_cache = []
cache_ttl = 60
last_scan_time = 0
_scan_results = {}  # {address: (BLEDevice, AdvertisementData)} from last scan
_state_lock = asyncio.Lock()
_bms_plugins_loaded = False

def _ensure_plugins():
    global _bms_plugins_loaded
    if not _bms_plugins_loaded:
        from aiobmsble.utils import load_bms_plugins
        load_bms_plugins()
        _bms_plugins_loaded = True

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in BMS_ALLOW_ORIGINS.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ResponseSizeLimitMiddleware(BaseHTTPMiddleware):
    """Cap JSON response body size to prevent memory exhaustion."""
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if hasattr(response, "body") and response.body:
            body_length = len(response.body)
            if body_length > MAX_RESPONSE_BYTES:
                return JSONResponse(
                    status_code=500,
                    content={"error": f"Response too large ({body_length} bytes)", "max": MAX_RESPONSE_BYTES},
                )
        return response

app.add_middleware(ResponseSizeLimitMiddleware)

@app.get("/health")
async def health():
    result = {"status": "ok", "service": "bms-bridge"}
    try:
        from bleak import BleakScanner
        # Quick probe: list available adapters without starting a scan
        adapters = await BleakScanner.discover(timeout=1.0, return_adv=False)
        result["ble_adapters"] = len(adapters)
        result["ble_available"] = True
    except Exception:
        result["ble_available"] = False
        result["ble_error"] = "BLE adapter check failed"
        logger.exception("BLE adapter check failed", exc_info=True)
    return result

@app.get("/devices")
async def list_devices(force_scan: bool = False):
    """Scan for BLE BMS devices using bleak."""
    global discovered_cache, last_scan_time, _scan_results
    async with _state_lock:
        now = time.time()
        if not force_scan and discovered_cache and (now - last_scan_time) < cache_ttl:
            logger.info(f"Returning cached {len(discovered_cache)} devices")
            return discovered_cache

    scanner = None
    try:
        from bleak import BleakScanner
        logger.info(f"Scanning for BLE devices using bleak ({BLE_SCAN_TIMEOUT}s scan)...")
        devices_found = []
        all_devices = []
        local_scan_results = {}

        def detection_callback(device, advertisement_data):
            all_devices.append({
                "address": device.address,
                "name": device.name or f"Unknown ({device.address[:8]})",
                "rssi": advertisement_data.rssi
            })
            local_scan_results[device.address] = (device, advertisement_data)
            if device.name and any(kw in device.name.lower() for kw in ["bms", "jk", "jbd", "daly"]):
                devices_found.append({
                    "address": device.address,
                    "name": device.name,
                    "rssi": advertisement_data.rssi
                })

        scanner = BleakScanner(detection_callback)
        await scanner.start()
        logger.info(f"Scan started, waiting {BLE_SCAN_TIMEOUT}s...")
        await asyncio.sleep(BLE_SCAN_TIMEOUT)
    except ImportError:
        logger.error("bleak not installed")
        raise HTTPException(status_code=500, detail="No BLE scanning library available")
    except OSError:
        logger.exception("Bluetooth adapter error", exc_info=True)
        raise HTTPException(status_code=500, detail="Bluetooth not accessible")
    except Exception:
        logger.exception("Unexpected error during scan", exc_info=True)
        raise HTTPException(status_code=500, detail="Device scan failed")
    finally:
        if scanner is not None:
            try:
                await scanner.stop()
                logger.info("Scanner stopped")
            except Exception:
                logger.exception("Error stopping scanner", exc_info=True)

    # Post-scan: update global state under lock
    async with _state_lock:
        # Deduplicate by address (keep highest RSSI)
        deduped_all = {}
        for d in all_devices:
            addr = d["address"]
            if addr not in deduped_all or d["rssi"] > deduped_all[addr]["rssi"]:
                deduped_all[addr] = d
        deduped_bms = {}
        for d in devices_found:
            addr = d["address"]
            if addr not in deduped_bms or d["rssi"] > deduped_bms[addr]["rssi"]:
                deduped_bms[addr] = d

        all_devices = list(deduped_all.values())
        devices_found = list(deduped_bms.values())
        logger.info(f"Scan complete. Found {len(devices_found)} BMS devices, {len(all_devices)} total devices")

        if not devices_found and all_devices:
            logger.warning(f"No devices matched BMS keywords, returning all {len(all_devices)} devices")
            discovered_cache = all_devices
        else:
            discovered_cache = devices_found

        _scan_results = local_scan_results
        last_scan_time = now

    return discovered_cache

@app.get("/device/{address}")
async def get_device_data(address: str):
    """Connect to a BMS and read its data using aiobmsble v0.25+."""
    try:
        _ensure_plugins()
        from aiobmsble.utils import bms_identify

        # Get the stored ble_device and advertisement data from last scan
        if address not in _scan_results:
            raise HTTPException(status_code=404, detail=f"Device {address} not in scan cache. Run /devices first.")

        ble_device, adv_data = _scan_results[address]

        # Identify the BMS type from advertisement data
        bms_cls = await bms_identify(adv_data, address)
        if bms_cls is None:
            raise HTTPException(status_code=501, detail=f"Cannot identify BMS type for {address}")

        logger.info(f"Identified {address} as {bms_cls.__name__}, connecting...")
        bms = bms_cls(ble_device)
        sample = await bms.async_update()
        data = sample if isinstance(sample, dict) else (sample.as_dict() if hasattr(sample, "as_dict") else sample.__dict__)
        clean = {k: v for k, v in data.items() if isinstance(v, (int, float))}
        logger.info(f"Successfully read data from {address}")
        return clean

    except HTTPException:
        raise
    except ImportError:
        logger.exception("aiobmsble import error", exc_info=True)
        raise HTTPException(status_code=501, detail="Reading not supported for this device")
    except Exception:
        logger.exception(f"Error reading {address}", exc_info=True)
        raise HTTPException(status_code=500, detail="Device read failed")

@app.post("/scan")
async def force_scan():
    """Force a fresh scan, ignoring cache."""
    logger.info("Force scan requested")
    return await list_devices(force_scan=True)
