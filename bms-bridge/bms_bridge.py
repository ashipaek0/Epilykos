"""
Bluetooth BMS Bridge for Epilykos Dashboard
Uses aiobmsble to discover and read BMS devices (JK, JBD, Daly, etc.)
Exposes a simple HTTP API for the main Node.js dashboard.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from aiobmsble import discover, connect
import asyncio
import logging
from contextlib import asynccontextmanager
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bms-bridge")

# Cache for discovered devices
discovered_cache = []
cache_ttl = 60
last_scan_time = 0

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: nothing special
    yield
    # Shutdown: close any open connections if needed
    pass

app = FastAPI(lifespan=lifespan)

# Allow CORS for local development
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
    """
    Scan for BMS devices within range.
    Returns list of devices with address, name, RSSI.
    """
    global discovered_cache, last_scan_time
    now = time.time()
    if not force_scan and discovered_cache and (now - last_scan_time) < cache_ttl:
        return discovered_cache

    try:
        logger.info("Scanning for BLE BMS devices...")
        # discover() returns a list of Device objects
        devices = await asyncio.wait_for(discover(), timeout=5.0)
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
    """
    Connect to a specific BMS by its MAC address and read all data.
    Returns a dictionary of metrics (voltage, current, SOC, etc.).
    """
    try:
        logger.info(f"Connecting to {address}")
        bms = await connect(address)
        # The BMS object has properties like voltage, current, soc, etc.
        # Let's extract all numeric attributes we can find.
        data = {}
        # Known attributes from aiobmsble (common across JK, JBD, Daly)
        for attr in ['voltage', 'current', 'soc', 'temperature', 'cells', 'cell_voltages', 'capacity_remain', 'capacity_nominal', 'cycles', 'balance', 'fet']:
            if hasattr(bms, attr):
                val = getattr(bms, attr)
                if isinstance(val, (int, float)):
                    data[attr] = val
        # If the BMS has cell voltages array, we can also report min/max or individual cells
        if hasattr(bms, 'cell_voltages') and bms.cell_voltages:
            data['min_cell_voltage'] = min(bms.cell_voltages)
            data['max_cell_voltage'] = max(bms.cell_voltages)
            data['cells_count'] = len(bms.cell_voltages)
        logger.debug(f"Data from {address}: {data}")
        await bms.disconnect()
        return data
    except Exception as e:
        logger.error(f"Error reading {address}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
