"""
Bluetooth BMS Bridge for Epilykos Dashboard
Uses bleak for scanning, aiobmsble v0.25+ for reading.
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import logging
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bms-bridge")

discovered_cache = []
cache_ttl = 60
last_scan_time = 0
_scan_results = {}  # {address: (BLEDevice, AdvertisementData)} from last scan
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
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return {"status": "ok", "service": "bms-bridge"}

@app.get("/devices")
async def list_devices(force_scan: bool = False):
    """Scan for BLE BMS devices using bleak."""
    global discovered_cache, last_scan_time, _scan_results
    now = time.time()
    if not force_scan and discovered_cache and (now - last_scan_time) < cache_ttl:
        logger.info(f"Returning cached {len(discovered_cache)} devices")
        return discovered_cache

    try:
        from bleak import BleakScanner
        logger.info("Scanning for BLE devices using bleak (10 second scan)...")
        devices_found = []
        all_devices = []
        _scan_results = {}

        def detection_callback(device, advertisement_data):
            all_devices.append({
                "address": device.address,
                "name": device.name or f"Unknown ({device.address[:8]})",
                "rssi": advertisement_data.rssi
            })
            _scan_results[device.address] = (device, advertisement_data)
            if device.name and any(kw in device.name.lower() for kw in ["bms", "jk", "jbd", "daly"]):
                devices_found.append({
                    "address": device.address,
                    "name": device.name,
                    "rssi": advertisement_data.rssi
                })

        scanner = BleakScanner(detection_callback)
        await scanner.start()
        logger.info("Scan started, waiting 10 seconds...")
        await asyncio.sleep(10.0)
        await scanner.stop()

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

        last_scan_time = now
        return discovered_cache

    except ImportError:
        logger.error("bleak not installed")
        raise HTTPException(status_code=500, detail="No BLE scanning library available")
    except OSError as e:
        logger.error(f"Bluetooth adapter error: {e}")
        raise HTTPException(status_code=500, detail=f"Bluetooth not accessible: {e}")
    except Exception as e:
        logger.error(f"Unexpected error during scan: {e}")
        raise HTTPException(status_code=500, detail=f"Scan error: {e}")

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
    except ImportError as e:
        logger.warning(f"aiobmsble import error: {e}")
        raise HTTPException(status_code=501, detail=f"Reading not supported: {e}")
    except Exception as e:
        logger.error(f"Error reading {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/scan")
async def force_scan():
    """Force a fresh scan, ignoring cache."""
    logger.info("Force scan requested")
    return await list_devices(force_scan=True)
