"""
Bluetooth BMS Bridge for Epilykos Dashboard
Uses bleak for scanning (fallback to aiobmsble if available)
Improved: Longer timeout, shows all devices, better logging
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
        logger.info(f"Returning cached {len(discovered_cache)} devices")
        return discovered_cache

    try:
        # Try using aiobmsble first
        from aiobmsble import scan
        logger.info("Scanning for BMS devices using aiobmsble...")
        devices = await asyncio.wait_for(scan(), timeout=10.0)
        result = [{"address": d.address, "name": d.name or "Unknown", "rssi": d.rssi} for d in devices]
        discovered_cache = result
        last_scan_time = now
        logger.info(f"Found {len(result)} devices via aiobmsble")
        return result
    except ImportError:
        logger.warning("aiobmsble not available, falling back to bleak")
    except Exception as e:
        logger.warning(f"aiobmsble scan failed: {e}, falling back to bleak")

    # Fallback to bleak
    try:
        from bleak import BleakScanner
        logger.info("Scanning for BLE devices using bleak (10 second scan)...")
        devices_found = []
        all_devices = []

        def detection_callback(device, advertisement_data):
            """Filter for known BMS device names."""
            if device.name:
                # Add to all_devices list regardless
                all_devices.append({
                    "address": device.address,
                    "name": device.name,
                    "rssi": advertisement_data.rssi
                })
                # Add to BMS-specific list if name matches
                if any(keyword in device.name.lower() for keyword in ["bms", "jk", "jbd", "daly"]):
                    devices_found.append({
                        "address": device.address,
                        "name": device.name,
                        "rssi": advertisement_data.rssi
                    })

        scanner = BleakScanner(detection_callback)
        await scanner.start()
        logger.info("Scan started, waiting 10 seconds...")
        await asyncio.sleep(10.0)  # Extended from 5s to 10s for slower devices
        await scanner.stop()
        logger.info(f"Scan complete. Found {len(devices_found)} BMS devices, {len(all_devices)} total devices")

        # If no devices found with keyword filtering, return all devices
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
    """Connect to a BMS and read its data."""
    try:
        from aiobmsble import connect
        logger.info(f"Attempting to connect to {address}...")
        bms = await connect(address)
        sample = await bms.async_update()
        data = sample.as_dict() if hasattr(sample, "as_dict") else sample.__dict__
        clean = {k: v for k, v in data.items() if isinstance(v, (int, float))}
        logger.info(f"Successfully read data from {address}")
        return clean
    except ImportError:
        logger.warning("aiobmsble not available for reading")
        raise HTTPException(status_code=501, detail="Reading not supported without aiobmsble")
    except Exception as e:
        logger.error(f"Error reading {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/scan")
async def force_scan():
    """Force a fresh scan, ignoring cache."""
    logger.info("Force scan requested")
    return await list_devices(force_scan=True)
