import aiobmsble
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import logging
import time
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bms-bridge")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cache for discovered devices
discovered_cache = []
cache_ttl = 60
last_scan_time = 0

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/devices")
async def list_devices(force_scan: bool = False):
    global discovered_cache, last_scan_time
    now = time.time()
    if not force_scan and discovered_cache and (now - last_scan_time) < cache_ttl:
        return discovered_cache
    try:
        logger.info("Scanning for BLE BMS devices...")
        # Use aiobmsble.scan if available, else fallback to aiobmsble.discover
        if hasattr(aiobmsble, 'scan'):
            devices = await asyncio.wait_for(aiobmsble.scan(), timeout=5.0)
        elif hasattr(aiobmsble, 'discover'):
            devices = await asyncio.wait_for(aiobmsble.discover(), timeout=5.0)
        else:
            raise Exception("No scan/discover function found in aiobmsble")
        result = [{"address": d.address, "name": d.name or "Unknown", "rssi": d.rssi} for d in devices]
        discovered_cache = result
        last_scan_time = now
        logger.info(f"Found {len(result)} devices")
        return result
    except asyncio.TimeoutError:
        logger.warning("Scan timeout")
        raise HTTPException(status_code=504, detail="Scan timeout")
    except Exception as e:
        logger.error(f"Scan error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/device/{address}")
async def get_device_data(address: str):
    try:
        logger.info(f"Connecting to {address}")
        if hasattr(aiobmsble, 'connect'):
            bms = await aiobmsble.connect(address)
        else:
            raise Exception("No connect function in aiobmsble")
        # Extract data
        data = {}
        for attr in ['voltage', 'current', 'soc', 'temperature', 'cells', 'cell_voltages', 'capacity_remain', 'capacity_nominal', 'cycles']:
            if hasattr(bms, attr):
                val = getattr(bms, attr)
                if isinstance(val, (int, float)):
                    data[attr] = val
                elif attr == 'cell_voltages' and val:
                    data['min_cell_voltage'] = min(val)
                    data['max_cell_voltage'] = max(val)
                    data['cells_count'] = len(val)
        await bms.disconnect()
        logger.debug(f"Data from {address}: {data}")
        return data
    except Exception as e:
        logger.error(f"Error reading {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
