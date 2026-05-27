FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    python3-dev \
    libbluetooth-dev \
    bluetooth \
    bluez \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Debug: list installed package and available functions
RUN pip show aiobmsble && \
    python -c "import aiobmsble; print('Available functions:', dir(aiobmsble))"

COPY bms_bridge.py .

EXPOSE 8020

CMD ["uvicorn", "bms_bridge:app", "--host", "0.0.0.0", "--port", "8020"]
