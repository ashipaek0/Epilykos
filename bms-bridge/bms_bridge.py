"""
Bluetooth BMS Bridge for Epilykos Dashboard
Uses bleak for reliable scanning, aiobmsble for reading (if available)
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from bleak import BleakScanner
import asyncio
import logging
import time
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bms-bridge")

discovered_cache = []
cache_ttl = 60
last_scan_time = 0

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
    """Scan for BLE devices, filter those that look like BMS (by name)."""
    global discovered_cache, last_scan_time
    now = time.time()
    if not force_scan and discovered_cache and (now - last_scan_time) < cache_ttl:
        return discovered_cache

    try:
        logger.info("Scanning for BLE devices...")
        devices_found = []

        def detection_callback(device, advertisement_data):
            if device.name and any(keyword in device.name for keyword in ["BMS", "JK", "JBD", "Daly"]):
                devices_found.append({
                    "address": device.address,
                    "name": device.name,
                    "rssi": advertisement_data.rssi
                })

        scanner = BleakScanner(detection_callback)
        await scanner.start()
        await asyncio.sleep(5.0)   # scan for 5 seconds
        await scanner.stop()

        discovered_cache = devices_found
        last_scan_time = now
        logger.info(f"Found {len(devices_found)} BMS devices")
        return devices_found

    except asyncio.TimeoutError:
        logger.warning("Scan timeout")
        raise HTTPException(status_code=504, detail="Scan timeout")
    except Exception as e:
        logger.error(f"Scan error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/device/{address}")
async def get_device_data(address: str):
    """
    Connect to a BMS and read its data using aiobmsble (if available).
    Falls back to a mock response if the library is missing.
    """
    try:
        from aiobmsble import connect
        bms = await connect(address)
        sample = await bms.async_update()
        data = sample.as_dict() if hasattr(sample, "as_dict") else sample.__dict__
        # Keep only numeric values
        clean = {k: v for k, v in data.items() if isinstance(v, (int, float))}
        logger.debug(f"Data from {address}: {clean}")
        return clean
    except ImportError:
        logger.warning("aiobmsble not available, returning mock data")
        return {"voltage": 0.0, "current": 0.0, "soc": 0}
    except Exception as e:
        logger.error(f"Error reading {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
