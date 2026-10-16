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

## Table of Contents

- [Quick Start](#quick-start)
- [Docker Compose](#docker-compose)
- [Adding Data Sources](#adding-data-sources)
- [Dashboard Editor](#dashboard-editor)
- [Card Showcase and Controls](#card-showcase-and-controls)
- [PWA & Network Switching](#pwa--network-switching)
- [Notifications](#notifications)
- [Updates](#updates)
- [Key Features](#key-features)
- [Reverse Proxy](#reverse-proxy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Quick Start

```bash
git clone https://github.com/ashipaek0/epilykos.git
cd epilykos
cp .env.example .env && nano .env   # set SETTINGS_PASSWORD (optional — see below)
docker compose up -d
```

Then open `http://localhost:3000/setup`. If you set `SETTINGS_PASSWORD`, the wizard asks for it.
Otherwise the first person to open the wizard chooses the admin password; after that, setup and
Settings need it. Open the wizard yourself right after the first start (or set `SETTINGS_PASSWORD`
when the server is reachable by people you don't trust).

| URL | Purpose |
|-----|---------|
| `http://localhost:3000` | Live dashboard (public, no login) |
| `http://localhost:3000/settings` | Settings panel (password-protected) |
| `http://localhost:3000/editor` | Dashboard layout editor |

---

## Docker Compose

```yaml
services:
  epilykos:
    image: irunmole/epilykos:latest
    container_name: epilykos
    restart: unless-stopped
    ports:
      - "3000:3000"                  # Ignored with network_mode: host (the app then listens on host port 3000)
    volumes:
      - ./data:/app/data
      - /etc/localtime:/etc/localtime:ro
      - /run/dbus:/run/dbus:ro        # Bluetooth BMS / inverter Bluetooth modules: talk to the host's BlueZ over D-Bus.
      # "Update now" in Settings → Updates. This gives Epilykos full control of Docker on
      # this computer (it could start any container), so only keep it if you want one-click
      # updates. Without it, update with: docker compose pull && docker compose up -d
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - TZ=Africa/Lagos              # Time zone for day boundaries. Remove this line to follow the host clock.
    # devices:
    #   - "/dev/ttyUSB0:/dev/ttyUSB0"        # USB serial adapter (RS232 / RS485 inverter or wired BMS). Add more for multiple devices
    # group_add:
    #   - "dialout"                  # Serial port permissions
    #   - "108"                      # the host bluetooth group ID from `getent group bluetooth`. Uncomment and set only if Settings shows "D-Bus denied access to BlueZ"
    security_opt:
      - apparmor=unconfined
    #network_mode: "host"            # Host networking is only needed for Tuya LAN broadcast discovery.
```

> **Bluetooth:** Bluetooth BMS and inverter Bluetooth modules are built in. It uses the host's
> Bluetooth adapter through BlueZ over D-Bus, so the only requirement is the `/run/dbus` mount:
>
> - Mount the **`/run/dbus` directory**
> - The host must run BlueZ with a powered adapter: `systemctl status bluetooth` shows *active*, `bluetoothctl show`
>   shows `Powered: yes`.
> - If Settings reports *D-Bus denied access to BlueZ*, add the host's `bluetooth` group ID (`getent group bluetooth`)
>   under `group_add`; on Ubuntu hosts also add `security_opt: [apparmor=unconfined]`.
>
> Drop the mount if you don't use Bluetooth. Drop `devices` and `group_add` if you don't use a USB serial adapter —
> `devices` must list at least one device or be removed entirely.

**Docker Hub image:** `irunmole/epilykos:latest`

---

## Adding Data Sources

Open `/settings`, log in, and navigate to **Data Sources**. Epilykos supports the following source types:

### Inverter Dongle
Wi-Fi / LAN dongles over TCP or the inverter's Bluetooth link. 
Supported protocols: **Solarman V5**, **Modbus TCP**, **Growatt**, **LuxPower**, **Felicity**.
over Bluetooth **Modbus over BLE**, **LuxPower** and **Phocos Any-Grid**.  

Choose **Connection** (TCP/IP or Bluetooth), then the **Profile** — the list only offers profiles that work over the
chosen connection. For TCP/IP enter the dongle's IP address; for Bluetooth use 🔍 Scan. Then test the connection.

**Bluetooth modules:** some inverters ship a Bluetooth module that carries plain Modbus-RTU over BLE, e.g. SRNE and
Renogy-style BT modules. Set Connection to **Bluetooth**, pick your inverter's register profile, use 🔍 Scan to pick
the module's MAC, and test. 
The default characteristics are `ffd1` (write) and `fff1` (notify). If your module uses different ones, you can read them with a BLE explorer app such as nRF Connect. 

Note that many Wi-Fi + Bluetooth dongles use Bluetooth only for Wi-Fi setup and don't serve live data over it.

Dongles usually accept only one Bluetooth connection at a time.

### Home Assistant
Enter your Home Assistant URL and a **Long-Lived Access Token**. Fetch available entities and map them to dashboard metrics.

### MQTT
Enter your broker URL and map MQTT topics to the metrics you want to display.

### Modbus
Supported profiles: **SRNE**, **Deye**, **Growatt**, **Victron**, **Voltronic/Axpert**, **Solis**, **Luxpower**, **Felicity**, **Generic MPPT**.  
Connects via a serial RS-485 adapter or over TCP. 
Only the Victron profile is native Modbus-TCP; the others are RS-485 (Modbus-RTU) register maps, which you can also reach over the network through an RS-485→Ethernet gateway — pick the gateway's framing (Modbus-TCP or RTU over TCP) on the card. 
All profiles are validated against official manufacturer register maps.

### Tuya (Smart Life)

Connect Tuya-compatible smart devices directly on your LAN — no cloud dependency for runtime data. Epilykos polls devices locally via encrypted TCP (port 6668).

**One-time setup:** Enter your Smart Life UID, scan a QR code to authenticate, and all devices are automatically populated with their local keys and DP (Data Point) labels fetched from the cloud. After that, everything runs locally.

**Manual setup:** For devices not discovered via the cloud flow, enter the Device ID, Local Key, and IP Address directly.

### External REST API
Point Epilykos at any HTTP(S) API that returns JSON — on your LAN (e.g. `http://192.168.1.50/status`) or on the internet. Map JSON field paths to dashboard metrics. Loopback and cloud-metadata addresses are blocked.

### Bluetooth BMS
Built in (needs the `/run/dbus` mount, see [Docker Compose](#docker-compose)). 
Scan for nearby devices; recognised BMS are labelled with their type. 
Decoding uses [aiobmsble](https://pypi.org/project/aiobmsble/), which covers JK, JBD, Daly, Seplos, ANT, Renogy, EG4, Pace and many more. 
Values are stored as `bms_<name>_<key>`, e.g. `voltage`,`current`, `battery_level`, `cell_voltage_1`, `temp_1`.

If a rebranded pack is found by Scan but not recognised, set its **type** (JBD, JK, Daly, Seplos, ANT, PACE / PACEEX) next to the
MAC address.

### BMS — Wired (RS485 / UART)
Pick the serial port and a profile; the serial settings follow the profile.
- **JBD / Jiabaida / Xiaoxiang / Overkill Solar** — UART (USB-TTL) or RS485, 9600 8N1.
- **JK-BMS (JK-B / JK-BD)** — JK RS485 adapter or UART port, 115200 8N1. (The newer JK-PB inverter BMS speaks a
  different Modbus protocol and is not covered yet.)
- **PACE (protocol 25)** — PACE's published RS232/RS485 protocol used by many packs (Jakiper, Easun, Tewaycell,
  Greenrich, FSP, Eenovance…), 9600 8N1; set the pack's DIP-switch address. Older protocol-20 packs (e.g. EG4
  LifePower4) are not covered yet.
- **Cworth CE-H6K / CE-LBW-48100C (PACE)** — Modbus-RTU over RS485.

Wired JBD and JK packs report the same metric names as over Bluetooth (`voltage`, `current`, `battery_level`,
`cell_voltage_N`, `temp_N`…), so dashboards and banks work with either connection.

Most BMS and inverter modules accept **one Bluetooth connection at a time**, so close the vendor phone app while
Epilykos is connected. All Bluetooth devices share one adapter and are polled one after another.

### RS232 Serial
Connect inverters via USB-to-RS232/RS485 adapter. Supported protocols:
- **Voltronic QPIGS** — Voltronic, Axpert, Infinisolar, Phocos, MUST, Sako (2400 8N1)
- **Victron VE.Direct** — SmartSolar, BMV, MultiPlus via VE.Direct cable (19200 8N1, streaming)
- **SolaX Pocket USB** — SolaX X1/X3 series via USB-to-TTL adapter (9600 8N1, binary AA55)
- **Modbus-RTU** — e.g. Anern EVO4200L over RS485

Select your inverter's profile, pick the detected serial port, and save. The 30-second poll loop and WebSocket updates work identically to other data sources.

---

## Dashboard Editor

Open `/editor` to customise your dashboard layout. Blocks can be dragged, resized, and rearranged freely. Each block is independently configurable — choose its metric source, colour scheme, transparency, and font size.

Multiple dashboards are supported, with automatic switching between desktop and mobile layouts.

---

## Card Showcase and Controls

Two pages for signed-in use only. Signed out, every address under them (the pages, their files and any sub path) goes to the sign-in page, and they are never kept in the browser's offline cache.

- **`/showcase`** — every dashboard card, filled with made-up readings from an imaginary home, updating every few seconds. Try each card's options (size, titles, periods, styles) to see what it can do. Nothing on the page reads your data or reaches your devices.
- **`/controls`** — where inverter and battery settings are changed, and where the switch and selector cards work (on the dashboard they show a link here):
  - **Allow device changes** is off until you turn it on; while off, nothing can change a device setting.
  - Changes need your password again; the unlock lasts 5 minutes and ends when you sign out.
  - Each setting is read first. A change is refused when the new value is outside the setting's range or step, when the device reports a current value outside that range (the register may mean something else on your model), or when it changed since the page showed it. After writing, the setting is read back and a different value is reported.
  - **Expert register writes** (off by default) allow any register number, for registers you have checked in your device's manual.
  - Every attempt, refused ones included, is kept in the change log.

Settings available so far:

- **LuxPower** (GETA dongle, Wi-Fi or Bluetooth): battery charge-level limits.
- **JBD and JK Bluetooth BMS**: charging and discharging on/off. Turning discharging off cuts what the pack powers, so the page asks you to confirm that separately. A pack that refuses to turn charging back on is usually protecting itself.
- **Phocos Any-Grid** (Bluetooth): telemetry and allowlisted settings for recognized model profiles (3, 5, 6.5 and 8 kW). See [Phocos BLE details](#phocos-any-grid-ble).

---

## PWA & Network Switching

Epilykos can be installed as a **Progressive Web App** — on your phone or desktop for a native-like app experience.

| Feature | Detail |
|---------|--------|
| **Installable** | Add to home screen on iOS/Android/desktop |
| **Offline shell** | Static assets cached via Service Worker |
| **Real-time WebSocket** | Live dashboard updates pushed every 30s |
| **Background sync** | Periodic refresh every minute (keeps metrics fresh even when tab is closed) |
| **Network auto-switch** | Configure local (LAN) and remote (WAN) URLs in Settings — the app tries local first, falls back to remote |
| **IndexedDB cache** | Dashboard state persisted — instant load on app reopen |

> **Note:** Network switching requires the Service Worker. On first load, open Settings and save your local and remote URLs — they'll be sent to the Service Worker for routing.

---

## Notifications

**Settings → Notifications** sends alerts on any metric or event to:

- **Push to devices**: web push on every phone, tablet or computer where you turn it on. One channel can target all devices or only the ones you choose.
- **Telegram**: create a bot with @BotFather, paste its token, message the bot, then press *Find chat*.
- **Discord**: paste a channel webhook URL. It can optionally mention @here on critical alerts.
- **ntfy**: ntfy.sh or your own server. Turn on *Server is on my local network* for a LAN server.
- **Webhook**: the alert is POSTed as JSON (`source, title, message, severity, tag, url, timestamp`, plus `event` or `rule`) to Home Assistant, n8n, Node-RED or your own script. An optional Authorization header can be added.

Each **rule** picks its channels and watches either:

- **A metric**: above, below, equals (text works too, e.g. a grid status of `off`), changes, or has not updated for N minutes. Options: *for at least* to ignore spikes, a resolve margin, back-to-normal alerts, reminders and a cooldown.
- **An event**: grid outage or restored, a source stops or starts responding, MQTT broker drops or reconnects, solar forecast unavailable (e.g. Solcast quota used up), PVOutput alert, snapshot failed, server started. Wildcards such as `source.*` match a whole group.
- **A schedule**: a daily energy summary (today or yesterday), the solar forecast (tomorrow or today, optionally only when it is below N kWh — a "poor solar day ahead" warning), or the live status, at a set time on chosen weekdays. Scheduled reports are sent during quiet hours too.

Turn on *Answer commands in this chat* on a Telegram channel to ask the bot `/status`, `/today`, `/yesterday` or `/forecast`; only that chat gets answers.
Rule state (what is firing, cooldowns, the last scheduled run) survives restarts, so a restart neither repeats an alert nor sends a report twice.

Quiet hours hold back everything except critical alerts. Every delivery is listed under *History*.
Push needs Epilykos on an `https://` address (see [Reverse Proxy](#reverse-proxy)); on iPhone and iPad, add it to the Home Screen first.
Bot tokens, webhook URLs, Authorization headers and push keys are encrypted at rest, and the whole Notifications section is admin-only.

## Updates

Settings → **Updates** shows which build is running and whether a newer one is out. Two kinds:

- **A new release**: new features and fixes, with the list of changes.
- **Security updates**: the released image is rebuilt every Monday so the base system and the bundled tools (Node.js, Tailscale, cloudflared, Python packages) get their fixes. Nothing changes in how Epilykos works.

It checks once a day (turn that off on the same page, or set `UPDATE_CHECK=off`), and sends the *Update available* notification once per build. The check downloads a small file from this repository's `update-feed` branch, which CI updates after every image build; nothing about your install is sent.

**Installing:**

- **Docker Compose with the Docker socket mounted** (the `docker.sock` line in the compose file above): **Update now** asks for your admin password, downloads the new image, and restarts Epilykos on it with the same settings, volumes and devices. If the new version does not report healthy within three minutes, the previous one is started again and the page says so. The socket gives Epilykos full control of Docker on that computer; leave the line out if you don't want that.
- **Docker Compose without the socket**: the page shows the commands, `docker compose pull` then `docker compose up -d`.
- **EpilykosOS**: the appliance checks for and installs signed Epilykos releases itself, and goes back to the previous version if the new one is not healthy (see [docs/host-update-actions.md](docs/host-update-actions.md)). Operating-system updates are not offered from here yet.

Builds from the `dev` branch (`irunmole/epilykos:dev`) compare against development builds instead of releases. Images you build yourself have no build number and are never compared.

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
| **No forced login** | Dashboard can publicly accessible; settings require a login |

---

## Remote Access with Tailscale

No reverse proxy or port forwarding needed: Settings → Network → **Remote access** → **Connect with Tailscale**.

1. Sign in at the link (or scan the QR code) with your own Tailscale account. Tailscale is free for personal use.
2. **Create my address** gives an HTTPS address such as `https://epilykos.your-tailnet.ts.net`, reachable only from devices signed in to your Tailscale account (install the Tailscale app on your phone). If your Tailscale network hasn't turned on HTTPS yet, the card shows a link to do it once.
3. It fills in *Address away from home* if that is empty, so the installed app switches to it automatically.

**Open to the internet** (off by default) uses Tailscale Funnel so any browser can open the address. It asks for your admin password, which must be at least 12 characters.

How it runs: the image includes Tailscale's latest stable release at build time. `tailscaled` runs inside the container in userspace networking mode, started only when you turn remote access on, so no compose changes or extra permissions are needed. Its state is in `data/tailscale/` (not in database backups). **Turn off remote access** logs this device out of your Tailscale network. Remote access can only be turned on by a signed-in admin, so never before the admin password exists.

## Remote Access with a Cloudflare Tunnel

For a public address on your own domain (the domain must be on Cloudflare), with no ports to open: Settings → Network → **Cloudflare Tunnel**.

1. In Cloudflare Zero Trust, go to **Networks → Tunnels** and create a tunnel (type *Cloudflared*).
2. Copy the install command it shows and paste it into **Tunnel token or install command** (just the token starting with `eyJ` works too).
3. Under **Public hostname**, add your address (e.g. `energy.example.com`) with service **HTTP** and URL `localhost:3000`, and enter the same address in **Public address**.

Connecting asks for your admin password, which must be at least 12 characters, because the address is reachable from anywhere. Add Cloudflare Access to the hostname if you want an extra sign-in in front. `cloudflared` runs inside the container only while the tunnel is on. The token is stored encrypted, passed to `cloudflared` through its environment rather than the command line, and hidden in Settings → Logs and the diagnostics file. **Turn off tunnel** stops it and forgets the token.

The released image is rebuilt every Monday (and on demand from the Actions tab), so Tailscale, `cloudflared` and the base system's security updates arrive even without a new Epilykos release.

## Reverse Proxy

### WebSocket Support

Epilykos uses WebSocket connections for real-time dashboard updates. If you're running behind a reverse proxy (Caddy, Nginx, Traefik, Cloudflare), ensure WebSocket upgrade headers are forwarded.

**Caddy:**
```caddy
your-domain.com {
    reverse_proxy localhost:3000 {
        header_up Upgrade {http.request.header.Upgrade}
        header_up Connection {http.request.header.Connection}
        flush_interval -1
    }
}
```

**Nginx:**
```nginx
location /ws {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

**Service Worker note:** If you're using the PWA's network auto-switch, the Service Worker intentionally does **not** intercept `/ws` paths — WebSocket connections must reach the browser's native WebSocket stack directly. Intercepting them via `fetch()` would immediately close the connection.

### Cloudflare

If proxying through Cloudflare (orange cloud), WebSocket is supported on all plans. Ensure:
- The domain has Cloudflare's proxy enabled (not DNS-only)
- No firewall rules block WebSocket traffic

---

## Health check & runtime settings

`GET /healthz` (no login) returns `200 {"status":"ok",…}` once the app is serving and its database opens with the expected schema, and `503` otherwise. It never depends on the network, so a box with no Internet stays healthy. The Docker image uses it as its `HEALTHCHECK`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_TO_FILE` | `true` | `false` logs to stdout/stderr only (no `logs/` directory) — for read-only container roots |
| `LOG_DIR` | `logs/` | Where rotating log files go when file logging is on |
| `SQLITE_SYNCHRONOUS` | `NORMAL` | SQLite durability: `NORMAL`, `FULL` or `EXTRA` (`OFF` is refused) |
| `TMPDIR` | `/tmp` | Temporary directory for uploads (backup restore, layout import) |
| `BLUETOOTH` | `on` | `off` disables Bluetooth even when `/run/dbus` is mounted |
| `BLE_KEEP_ALIVE` | `true` | Keep Bluetooth connections open between polls (`false` reconnects every poll: slower, frees adapter slots) |
| `BLE_MAX_LINKS` | `1` | Bluetooth links (inverter dongles and BMS packs) kept open at once. With several devices on one adapter, the others are closed before the next connects; raise it if your adapter handles several connections well |
| `UPDATE_CHECK` | `on` | `off` never checks for updates (Settings → Updates) |
| `BLE_LOG_LEVEL` | `WARNING` | Bluetooth helper log level (`INFO` / `DEBUG` when diagnosing a device). Debug in Settings → Logs also turns the helper to `DEBUG` |

---

## Troubleshooting

| Symptom | Resolution |
|---------|------------|
| **No data displayed** | Verify at least one data source is enabled and actively producing metrics |
| **Settings page unavailable** | Confirm `SETTINGS_PASSWORD` is set correctly in `.env` |
| **Inverter dongle timeout** | Ping the dongle IP from the server and verify the port is reachable |
| **Charts are blank** | Open the browser console (`F12`) and check for JavaScript errors |
| **RS232 no ports found** | Verify USB-to-serial adapter is connected and user is in the `dialout` group |
| **`EACCES` on `/app/data` / `SQLITE_CANTOPEN` at startup** | Fixed in current images (the container now makes `./data` writable itself). On an older image: `sudo chown -R 1000:1000 ./data` then `docker compose up -d` |
| **RS232 permission denied** | `sudo usermod -a -G dialout $USER` then log out and back in |
| **RS232 scan error (ENOENT)** | Ensure the container has `udev` installed — the Docker image includes it by default |
| **WebSocket fails ("closed before connection is established")** | If using the PWA, unregister the old Service Worker and reload; also check [WebSocket reverse proxy configuration](#websocket-support) |
| **Bluetooth unavailable: mount the host D-Bus socket** | Add `- /run/dbus:/run/dbus:ro` to the `epilykos` volumes and recreate the container |
| **Bluetooth: D-Bus denied access to BlueZ** | The host's BlueZ D-Bus policy doesn't allow the container user (uid 1000). Add the host's `bluetooth` group ID via `group_add` (`getent group bluetooth`). On Ubuntu hosts with AppArmor D-Bus mediation, also add `security_opt: [apparmor=unconfined]` |
| **Bluetooth: no adapter / adapter powered off** | Check `bluetoothctl show` on the host; `rfkill unblock bluetooth` and `bluetoothctl power on` |
| **BMS scan returns no devices** | Move the adapter closer (BLE range is ~10 m), close the vendor app, and scan again. On a Raspberry Pi 3 a USB Bluetooth dongle is more reliable than the onboard radio |
| **Daily totals roll over at the wrong hour** | Set `TZ` (e.g. `TZ=Europe/Berlin`) or mount `/etc/localtime:/etc/localtime:ro`; the startup log line shows the active time zone |
| **Setup wizard says Epilykos is already set up, but you never set a password** | Someone else opened the wizard first. Set `SETTINGS_PASSWORD` in `.env` and recreate the container: that password then unlocks setup and Settings |
| **Need verbose logs** | Settings → Logs → **How much to log: Debug**. It applies at once, includes the Bluetooth helper, and turns itself back off after 30 minutes. **Diagnostics file** saves recent lines and settings with secrets hidden, to send when asking for help. (`LOG_LEVEL` in `.env` still sets the starting level; a level chosen in Settings overrides it.) |

---

## Development

```bash
npm ci
npm test                                            # runs every test/*.test.js (no hardware needed)
python3 modules/ble/ble_helper.py --self-test       # Bluetooth helper pure functions
PORT=3002 SETTINGS_PASSWORD=dev node server.js      # local instance (data/ in the working directory)
```

Bluetooth outside Docker needs Python ≥ 3.12 with `pip install -r modules/ble/requirements.txt` and a running BlueZ.

For a complete walkthrough of the codebase architecture — adding new block types, integrating new data sources, settings UI patterns, performance best practices, deployment workflows, and common pitfalls — see the **[Development Guide](https://github.com/ashipaek0/Epilykos/wiki/Development-Guide)** on the wiki.

---

## License

Epilykos is released under the **GNU General Public License v3.0**.  
See [`LICENSE`](LICENSE) for the full terms.

### Phocos Any-Grid BLE

The PSW-H profile exposes signed battery current/power (positive charging), gross
charging power, and estimated grid power (positive import). The grid estimate
ignores conversion losses; negative values and small flows are preserved. Rated
values and read-only setting snapshots are available in the entity selector.
Identity, ratings and settings blocks are read every 20th poll (and right after a
settings read or change); their snapshot metrics are recorded when they change
and at least every 4 minutes, so they don't add a row on every poll.
Existing explicit mappings are preserved: select additional entities to record
those values. Mode descriptions, serial/firmware strings and raw fault bytes
require explicit text mappings; setting flags are recorded as 0/1.

8 kW / 48 V units can change settings with the 5 kW / 48 V limits (charging
currents up to 80 A): the app has no limits of its own for them, and these can
only be stricter than the unit's real ratings. Other ratings are read-only, and
equalization-voltage writes and unresolved controls remain disabled.
Output-voltage changes require a fresh standby-mode read with AC output off.
24 V float/boost limits are 24–32 V; 48 V limits are 48–64 V. Current choices are
restricted to the recovered app's discrete values. Unknown bytes are preserved.

The authenticated Bluetooth connection-test API (`POST /api/dongle/test`) returns
raw block `values`, `identity` and `diagnostics` alongside its summary. Diagnostics
include resolved full UUIDs/properties/handles, read errors, lengths, firmware and
field confidence. Optional metadata errors do not erase good telemetry. Read
minimum lengths follow accessed offsets; settings writes retain strict block
checks. Settings-read responses also include diagnostics. `app_confirmed` means
static app evidence, not hardware validation. Inferred measurements are labelled.

Fault bytes are retained without claiming definitive alarms: the app overlaps two
little-endian words with an 8-bit shift. The recovered model code is byte 19 of
`2a02`. Evidence: PhocosLink 2.1.4 APK SHA-256
`105e075605f7653b49987e1494802af2aba0d272f41603e637cb4f8b2a004a30`.
Test coverage includes existing capture fixtures and synthetic edge cases;
automated checks do not perform hardware writes.
