FROM node:22-trixie-slim

# Install build tools required for better-sqlite3 native compilation
# tzdata: lets TZ names and a host-mounted /etc/localtime resolve to a zone
# Debian trixie ships Python 3.13; the Bluetooth BMS library (aiobmsble) needs >= 3.12.
RUN apt-get update && apt-get install -y python3 python3-pip make g++ udev tzdata && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages tinytuya tuya-device-sharing-sdk qrcode[pil] && rm -rf /root/.cache/pip

# Bluetooth LE (BMS + inverter Bluetooth modules). bleak talks to the HOST's
# BlueZ over the mounted system D-Bus socket (/run/dbus), so no BlueZ, host
# networking or privileged mode is needed inside the container.
COPY modules/ble/requirements.txt /tmp/ble-requirements.txt
RUN pip3 install --break-system-packages -r /tmp/ble-requirements.txt && rm -rf /root/.cache/pip /tmp/ble-requirements.txt

# Create app directory and set ownership
RUN mkdir -p /app/data && chown -R node:node /app
WORKDIR /app

# Install dependencies exactly as locked (no devDependencies)
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy the rest of the app
COPY --chown=node:node . .

# The container starts as root only so the entrypoint can make the bind-mounted
# /app/data writable on a fresh install (Docker creates a missing ./data as
# root). It then drops to the unprivileged `node` user before starting the app.
COPY docker/entrypoint.sh /usr/local/bin/epilykos-entrypoint
RUN chmod 0755 /usr/local/bin/epilykos-entrypoint
ENTRYPOINT ["/usr/local/bin/epilykos-entrypoint"]

EXPOSE 3000
# /healthz proves the app started and SQLite opened; it never depends on the
# network, so a box with no Internet stays "healthy".
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Run node directly (not via npm) so SIGTERM reaches server.js and the
# graceful shutdown (final metric flush, DB close) runs on `docker stop`.
CMD ["node", "server.js"]
