"""
Bluetooth BMS Bridge for Epilykos Dashboard
Uses bleak for scanning (fallback to aiobmsble if available)
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
    """Scan for BLE BMS devices."""
    global discovered_cache, last_scan_time
    now = time.time()
    if not force_scan and discovered_cache and (now - last_scan_time) < cache_ttl:
        return discovered_cache

    try:
        # Try using aiobmsble first
        from aiobmsble import scan
        logger.info("Scanning for BMS devices using aiobmsble...")
        devices = await asyncio.wait_for(scan(), timeout=5.0)
        result = [{"address": d.address, "name": d.name or "Unknown", "rssi": d.rssi} for d in devices]
        discovered_cache = result
        last_scan_time = now
        logger.info(f"Found {len(result)} devices")
        return result
    except ImportError:
        logger.warning("aiobmsble not available, falling back to bleak")
    except Exception as e:
        logger.warning(f"aiobmsble scan failed: {e}, falling back to bleak")

    # Fallback to bleak
    try:
        from bleak import BleakScanner
        logger.info("Scanning for BLE devices using bleak...")
        devices_found = []

        def detection_callback(device, advertisement_data):
            if device.name and any(keyword in device.name.lower() for keyword in ["bms", "jk", "jbd", "daly"]):
                devices_found.append({
                    "address": device.address,
                    "name": device.name,
                    "rssi": advertisement_data.rssi
                })

        scanner = BleakScanner(detection_callback)
        await scanner.start()
        await asyncio.sleep(5.0)
        await scanner.stop()

        discovered_cache = devices_found
        last_scan_time = now
        logger.info(f"Found {len(devices_found)} BMS devices")
        return devices_found
    except ImportError:
        logger.error("bleak not installed")
        raise HTTPException(status_code=500, detail="No BLE scanning library available")
    except OSError as e:
        logger.error(f"Bluetooth adapter error: {e}")
        raise HTTPException(status_code=500, detail=f"Bluetooth not accessible: {e}")

@app.get("/device/{address}")
async def get_device_data(address: str):
    """Connect to a BMS and read its data."""
    try:
        from aiobmsble import connect
        bms = await connect(address)
        sample = await bms.async_update()
        data = sample.as_dict() if hasattr(sample, "as_dict") else sample.__dict__
        clean = {k: v for k, v in data.items() if isinstance(v, (int, float))}
        logger.debug(f"Data from {address}: {clean}")
        return clean
    except ImportError:
        logger.warning("aiobmsble not available for reading")
        raise HTTPException(status_code=501, detail="Reading not supported without aiobmsble")
    except Exception as e:
        logger.error(f"Error reading {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
