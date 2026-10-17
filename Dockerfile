# Remote access (Settings → Network → Remote access): Tailscale's own static
# binaries from its official multi-arch image. `stable` is Tailscale's latest
# stable release; CI builds without a cache, so every Epilykos build carries
# the current one (EpilykosOS then pins the result by digest). tailscaled runs
# in userspace networking mode, started by the app only when the user turns
# remote access on, so the container needs no extra capabilities.
FROM tailscale/tailscale:stable AS tailscale

# Settings → Network → Cloudflare Tunnel: cloudflared's static binary from its
# official image (`latest` is its latest release). Runs inside the container
# only while a tunnel is on.
FROM cloudflare/cloudflared:latest AS cloudflared

FROM node:22-trixie-slim

# Install build tools required for better-sqlite3 native compilation
# tzdata: lets TZ names and a host-mounted /etc/localtime resolve to a zone
# Debian trixie ships Python 3.13; the Bluetooth BMS library (aiobmsble) needs >= 3.12.
RUN apt-get update && apt-get install -y python3 python3-pip make g++ udev tzdata util-linux && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages tinytuya tuya-device-sharing-sdk qrcode[pil] && rm -rf /root/.cache/pip

# Bluetooth LE (BMS + inverter Bluetooth modules). bleak talks to the HOST's
# BlueZ over the mounted system D-Bus socket (/run/dbus), so no BlueZ, host
# networking or privileged mode is needed inside the container.
COPY modules/ble/requirements.txt /tmp/ble-requirements.txt
RUN pip3 install --break-system-packages -r /tmp/ble-requirements.txt && rm -rf /root/.cache/pip /tmp/ble-requirements.txt

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/

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

# Paired EpilykosOS versions opt into the shared DATA maintenance lock.
LABEL io.epilykos.maintenance-lock="flock-v1"
EXPOSE 3000
# /healthz proves the app started and SQLite opened; it never depends on the
# network, so a box with no Internet stays "healthy".
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Run node directly (not via npm) so SIGTERM reaches server.js and the
# graceful shutdown (final metric flush, DB close) runs on `docker stop`.
CMD ["node", "server.js"]

# Which build this is (set by CI; empty in local builds). Settings → Updates
# shows it and compares it with the update feed. Last, so it never changes the
# layers above.
ARG EPILYKOS_VERSION=""
ARG EPILYKOS_CHANNEL=""
ARG EPILYKOS_BUILD_ID=""
ARG EPILYKOS_COMMIT=""
ARG EPILYKOS_BUILT_AT=""
ENV EPILYKOS_VERSION=${EPILYKOS_VERSION} EPILYKOS_CHANNEL=${EPILYKOS_CHANNEL} EPILYKOS_BUILD_ID=${EPILYKOS_BUILD_ID} \
    EPILYKOS_COMMIT=${EPILYKOS_COMMIT} EPILYKOS_BUILT_AT=${EPILYKOS_BUILT_AT}
