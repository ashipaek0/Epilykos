FROM python:3.11-slim

WORKDIR /app

# Install system dependencies required for aiobmsble and Bluetooth
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    python3-dev \
    libbluetooth-dev \
    bluetooth \
    bluez \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bms_bridge.py .

EXPOSE 8000

CMD ["uvicorn", "bms_bridge:app", "--host", "0.0.0.0", "--port", "8000"]
