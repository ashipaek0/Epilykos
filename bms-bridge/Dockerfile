FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    bluetooth \
    bluez \
    libbluetooth-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bms_bridge.py .

EXPOSE 8000

CMD ["uvicorn", "bms_bridge:app", "--host", "0.0.0.0", "--port", "8000"]
