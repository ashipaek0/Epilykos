<div align="center">

# ⚡ Epilykos

**Self-hosted, real-time energy monitoring — built for solar, inverters, and home automation.**

[![Docker Hub](https://img.shields.io/docker/pulls/irunmole/epilykos?logo=docker&label=Docker%20Pulls&color=2496ED)](https://hub.docker.com/r/irunmole/epilykos)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/ashipaek0/epilykos?style=flat&logo=github)](https://github.com/ashipaek0/epilykos)

Connects directly to inverters, Battery BMS, Home Assistant, over MQTT, Modbus, RS232 serial, Bluetooth, and REST APIs.  
Public display with no login required — settings are password-protected.  
**PWA** with real-time WebSocket push, network auto-switching, and background sync.

</div>

---

## Documentation

Guides for everything below live in the **[Epilykos Wiki](https://epilykos.ashipaek0.com.ng/)**:

| Topic | Guides |
|-------|--------|
| Install | [Raspberry Pi with EpilykosOS](https://epilykos.ashipaek0.com.ng/getting-started/install-epilykos-os/) · [Docker](https://epilykos.ashipaek0.com.ng/getting-started/install-docker/) · [First-run setup](https://epilykos.ashipaek0.com.ng/getting-started/first-run-setup/) |
| Connect equipment | [Choosing a source](https://epilykos.ashipaek0.com.ng/data-sources/) · [Inverter dongles](https://epilykos.ashipaek0.com.ng/data-sources/inverter-dongles/) · [Modbus](https://epilykos.ashipaek0.com.ng/data-sources/modbus/) · [RS232](https://epilykos.ashipaek0.com.ng/data-sources/rs232/) · [Battery BMS](https://epilykos.ashipaek0.com.ng/data-sources/bms/) · [Home Assistant](https://epilykos.ashipaek0.com.ng/data-sources/home-assistant/) · [MQTT](https://epilykos.ashipaek0.com.ng/data-sources/mqtt/) · [Tuya](https://epilykos.ashipaek0.com.ng/data-sources/tuya/) · [REST API](https://epilykos.ashipaek0.com.ng/data-sources/rest-api/) · [Supported hardware](https://epilykos.ashipaek0.com.ng/data-sources/supported-hardware/) |
| Dashboard | [Layout editor](https://epilykos.ashipaek0.com.ng/dashboard/editor/) · [Cards and the showcase](https://epilykos.ashipaek0.com.ng/dashboard/cards/) · [Device controls](https://epilykos.ashipaek0.com.ng/dashboard/controls/) · [Install as an app](https://epilykos.ashipaek0.com.ng/dashboard/app-and-network/) |
| Settings | [Metrics](https://epilykos.ashipaek0.com.ng/settings/metrics/) · [Forecast](https://epilykos.ashipaek0.com.ng/settings/forecast-and-weather/) · [Prices and savings](https://epilykos.ashipaek0.com.ng/settings/prices-and-savings/) · [Notifications](https://epilykos.ashipaek0.com.ng/settings/notifications/) · [Remote access](https://epilykos.ashipaek0.com.ng/settings/network-and-remote-access/) · [Two-step sign-in](https://epilykos.ashipaek0.com.ng/settings/security/) · [Backups](https://epilykos.ashipaek0.com.ng/settings/backup-and-restore/) · [Updates](https://epilykos.ashipaek0.com.ng/settings/updates-and-system/) |
| EpilykosOS | [Wi-Fi setup](https://epilykos.ashipaek0.com.ng/epilykos-os/wifi-setup/) · [Password and factory reset](https://epilykos.ashipaek0.com.ng/epilykos-os/password-and-reset/) · [Updates and recovery](https://epilykos.ashipaek0.com.ng/epilykos-os/updates-and-recovery/) |
| Help | [Troubleshooting](https://epilykos.ashipaek0.com.ng/troubleshooting/) · [Development guide](https://epilykos.ashipaek0.com.ng/development/development-guide/) |

---

## Quick Start

```bash
git clone https://github.com/ashipaek0/epilykos.git
cd epilykos
docker compose up -d
```

Then open `http://localhost:3000/setup`. The first person to open the wizard chooses the admin
password; after that, setup and Settings need it. Open the wizard yourself right after the first start,
and use at least 12 characters: opening Epilykos to the internet refuses a shorter admin password.

If people you don't trust can reach the server, set the password before the first start instead: in
`docker-compose.yaml` uncomment `environment:` and `- SETTINGS_PASSWORD=`, type the password after the
`=` (write each `$` as `$$`), and run `docker compose up -d`. The wizard then asks for that password,
and only the compose file can change it.

On a Raspberry Pi, flash **[EpilykosOS](https://github.com/ashipaek0/epilykos-os)** instead and open
`http://epilykos.local:3000`: see [Install on a Raspberry Pi](https://epilykos.ashipaek0.com.ng/getting-started/install-epilykos-os/).

| URL | Purpose |
|-----|---------|
| `http://localhost:3000` | Live dashboard (public, no login) |
| `http://localhost:3000/settings` | Settings panel (password-protected) |
| `http://localhost:3000/editor` | Dashboard layout editor |

---

## Docker Compose

```yaml
# Epilykos on Docker.
#   Start:   docker compose up -d
#   Update:  docker compose pull && docker compose up -d
#
# Lines starting with "# " below are options that are OFF. To turn one on, remove
# the "# " from every line of its block (the key and its items together) and keep
# the indentation exactly as it is, then run: docker compose up -d
services:
  epilykos:
    image: irunmole/epilykos:latest
    container_name: epilykos
    restart: unless-stopped
    ports:
      - "3000:3000"                  # Ignored with network_mode: host (the app then listens on host port 3000)
      # - "5279:5279"                # Growatt SPF stick (Growatt dongle profile): it pushes its data to this port. Not needed with network_mode: host.
    volumes:
      - ./data:/app/data
      - /etc/localtime:/etc/localtime:ro   # The container follows this computer's time zone.
      # - /var/run/docker.sock:/var/run/docker.sock # Option: "Update now" in Settings → Updates, and a Restart that works without a restart policy.
      # This gives Epilykos full control of Docker on this computer (it could start any container,
      # which is control of the computer), so it is off unless you want it. Without it, update with:
      # docker compose pull && docker compose up -d

      # - /run/dbus:/run/dbus:ro           # Option: Bluetooth BMS / inverter Bluetooth modules talk to the host's BlueZ over D-Bus.
      # Turn on the security_opt option below with it.
    # security_opt:
    #   - "apparmor=unconfined"          # ── Option: Bluetooth on Ubuntu needs AppArmor lifted for this container (with the D-Bus line above).
    # devices:
    #   - "/dev/ttyUSB0:/dev/ttyUSB0"        # ── Option: USB serial adapter (RS232 / RS485 inverter or wired BMS) and/or the Bluetooth group.
    # Uncomment `group_add:` and only the lines you need (at least one), and `devices:` with its line.
    # Add one line to `devices` per adapter. Docker refuses to start if a listed device does not exist.
    # group_add:
    #   - "dialout"                  # Serial port permission.
    #   - "108"                      # The host's bluetooth group ID, from `getent group bluetooth`; only if Settings says "D-Bus denied access to BlueZ".

    # Uncomment `environment:` and only the lines you need (at least one). A .env file is not passed
    # to the container, so environment variables go here. Write a "$" in a value as "$$".
    # environment:
    #   - SETTINGS_PASSWORD=         # Admin password, typed after the "=". The setup wizard then asks for it; only this file can change it.
    #   - TZ=Europe/London
    #   - TRUST_PROXY=172.16.0.0/12  # Only if a reverse proxy runs on another machine or container: the proxy's address. Without it, everyone behind it shares one login limit.

    # network_mode: "host"               # ── Option: host networking, only for Tuya LAN broadcast discovery (then `ports` above is ignored).
```

Bluetooth, USB serial adapters, a time zone, host networking for Tuya discovery and one-click updates
are explained in [Install with Docker](https://epilykos.ashipaek0.com.ng/getting-started/install-docker/), with the environment
variables and the `/healthz` health check. 

On Docker Desktop (Windows, macOS), USB adapters need
USB/IP and Bluetooth isn't available: see
[Docker Desktop on Windows and macOS](https://epilykos.ashipaek0.com.ng/getting-started/install-docker/#docker-desktop-on-windows-and-macos).

---

## Key Features

| Feature | Detail |
|---------|--------|
| **Block types** | 20+ types — flow diagrams, gauges, charts, tables, forecasts, grid status, text embeds, and more |
| **Multi-instance blocks** | Any block type can appear multiple times with different metric mappings |
| **Per-block configuration** | Metric source, colours, transparency, font size — all configurable independently |
| **Light / Dark mode** | Auto-detect or manual override |
| **Multiple dashboards** | Define separate layouts; desktop/mobile auto-switch |
| **Real-time updates** | WebSocket push every 30 seconds |
| **Searchable Help** | Accordion-based help section with search — covers all sources and block types |
| **PWA** | Installable, offline-capable, background sync |
| **Bluetooth** | BMS and inverter Bluetooth modules, built in |
| **No forced login** | The dashboard can be publicly accessible; settings require a login |

---

## Development

```bash
npm ci
npm test                                            # runs every test/*.test.js (no hardware needed)
python3 modules/ble/ble_helper.py --self-test       # Bluetooth helper pure functions
PORT=3002 SETTINGS_PASSWORD=dev node server.js      # local instance (data/ in the working directory)
```

Bluetooth outside Docker needs Python ≥ 3.12 with `pip install -r modules/ble/requirements.txt` and a running BlueZ.

For how the code fits together — the stack, repository layout, how data flows, adding a card or a data source, secrets at rest, builds and releases — see the **[Development guide](https://epilykos.ashipaek0.com.ng/development/development-guide/)** on the wiki.

User documentation lives in [ashipaek0/epilykos-wiki](https://github.com/ashipaek0/epilykos-wiki); see
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Epilykos is released under the **GNU General Public License v3.0**.  
See [`LICENSE`](LICENSE) for the full terms.
