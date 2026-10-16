# MATTER//HUB

A standalone Matter controller hub — a Home-Assistant-style web UI for **commissioning and
controlling Matter over Thread devices**, built in pure JavaScript (ESM, no build step) directly
on the local matter.js clone. Not part of, or dependent on, the Home Assistant ecosystem.

- **Controller**: matter.js 0.18 `ServerNode` + `ControllerBehavior` (`ClientNode` peer API)
- **Thread**: pulls the active Operational Dataset from an **OTBR REST API** and hands it to
  devices during BLE/IP commissioning; shows border-router + per-device Thread diagnostics
- **BLE**: commission devices that are not yet on any network (`@matter/nodejs-ble`, noble)
- **UI**: dependency-free single-page app served by the hub itself — dark grey surfaces, 1px
  white hairlines, technical mono type. HTTP + SSE (no websocket libs).

## Layout

```
hub/
├── src/
│   ├── index.js      entry — platform setup, HTTP server bootstrap
│   ├── Hub.js        controller node, commissioning, discovery, commands, events
│   ├── Entities.js   endpoint/cluster → UI entity model
│   ├── Otbr.js       OTBR REST client wrapper (status + Thread credentials)
│   ├── HttpApi.js    REST + SSE + static file server (node:http only)
│   └── Log.js        ring buffer log fanned out to the UI
└── public/           the web UI (index.html / style.css / app.js)
```

The hub is registered as a **workspace of the matter.js monorepo** (one line in the root
`package.json`), so every `@matter/*` import resolves to the local clone — including
`@matter/thread-br-client`, which is not published to npm.

## Requirements

- Node.js ≥ 22.13
- An OpenThread Border Router (OTBR) reachable over HTTP with its REST API (default port 8081)
- For BLE commissioning: a Bluetooth adapter on the hub host (Linux: `hci0`, bluez + noble
  prerequisites, see the `@matter/nodejs-ble` README)

## Setup

From the **matter.js repo root** (never install from inside `hub/`):

```bash
npm install          # installs and links all workspaces, builds all packages
```

Then start the hub:

```bash
npm start -w matter-hub            # or: cd hub && npm start
```

Open http://localhost:8410.

Useful flags (matter.js variable service picks these up):

```bash
node src/index.js --port 9000 --storage-path ./hub-storage --loglevel detail
```

## Running in podman

The image is defined in [`hub/Containerfile`](Containerfile) — a multi-stage build on
`node:26-slim` that compiles the whole monorepo (including the optional BLE native addons)
and prunes the dev toolchain out of the runtime layer.

Build from the **repo root** (the whole matter.js monorepo is the build context;
`.containerignore` keeps `.git`, `node_modules` and stale `dist` out):

```bash
podman build -f hub/Containerfile -t matter-hub:latest .
```

Run:

```bash
podman run -d --name matter-hub \
    --network host \
    -v matter-hub-data:/data \
    matter-hub:latest
```

- `--network host` is effectively **required**: mDNS commissionable-device discovery, Matter
  UDP sessions, and IPv6 reachability of Thread devices through the OTBR's mesh-local routes
  all break behind podman's NAT. With host networking the OTBR REST API at `localhost:8081`
  is reachable with the default settings, and the web UI is at `http://<host>:8410`.
- `-v matter-hub-data:/data` persists the fabric (certificates/keys), commissioned nodes and
  settings. Bind-mounting a host directory instead? `chown` it to uid 1000 (`node`).
- Env overrides: `HUB_HOST` (default `0.0.0.0`), `HUB_PORT` (default `8410`),
  `HUB_STORAGE` (default `/data`). Extra matter.js flags pass straight through:
  `podman run … matter-hub --loglevel detail`.

### BLE commissioning inside the container

BLE needs raw HCI access — run privileged (`--privileged`) or with
`--cap-add=NET_ADMIN --cap-add=NET_RAW`, still with `--network host`. The host's
`bluetoothd` usually owns `hci0`; if noble cannot open the adapter, stop `bluetoothd` on
the host (or pass a dedicated dongle). Enable BLE afterwards in the hub's **Settings** page.

```bash
podman run -d --name matter-hub --network host --privileged \
    -v matter-hub-data:/data matter-hub:latest
```

### Running the OTBR (podman)

The hub assumes an OTBR container with a Thread radio (RCP), for example:

```bash
podman run -d --name otbr \
  --network host --privileged \
  -v /dev/ttyACM0:/dev/ttyACM0 \
  ghcr.io/project-chip/openthread-border-router:latest
```

- `--network host` exposes the REST API (`:8081`) and lets the OTBR publish mesh-local
  IPv6 routes so the hub can reach commissioned Thread devices directly.
- `/dev/ttyACM0` — adjust to your RCP device.
- Form a Thread network once (OTBR web UI at `:80`), then the hub can fetch the dataset
  and commission Thread devices. Verify with:
  `podman exec otbr ot-ctl dataset active -x`

Set the OTBR host/port in **Settings** if it is not `localhost:8081`.

## Commissioning a Matter-over-Thread device

1. Put the device in pairing mode (factory-fresh or pairing-window).
2. **Commission** page → paste the 11-digit manual pairing code (or the full `MT:…` QR payload).
3. Keep **USE THREAD** checked — the hub fetches the active dataset from the OTBR and sends it
   to the device during commissioning.
4. If the device is not yet on any network, enable BLE in **Settings**, save, and restart the
   hub when Settings reports that a restart is required. Then check **DISCOVER OVER BLE** on
   the Commission page. The device joins the Thread network during
   commissioning and becomes reachable over IP through the border router.
5. The device appears on the dashboard, live-subscribed (OnOff, level, color, locks,
   thermostats, covers, fans, sensors, power/energy).

Alternative flows:

- **Scan** — lists commissionable devices found via mDNS (and BLE when enabled) and commissions
  a picked entry (passcode still required).
- **Manual discriminator + passcode** — under *Manual / Advanced*.
- **Already on IP** — a device already commissioned into another fabric can be added after the
  other admin opens a commissioning window: **Devices → DETAILS → OPEN PAIRING WINDOW** on that
  node is for sharing *your* fabric; to join a foreign admin's window just commission with the
  code it shows you.

## Controlling devices

Dashboard cards are driven by Matter clusters:

| Entity | Cluster(s) |
| --- | --- |
| Light / plug | OnOff, LevelControl (dim), ColorControl (hue/sat + color temperature) |
| Lock | DoorLock (`lockDoor` / `unlockDoor`) |
| Thermostat | localTemperature display, setpoint writes, systemMode |
| Cover | WindowCovering (`goToLiftPercentage`) |
| Fan | FanControl (`percentSetting`) |
| Sensors | Temperature / Humidity / Pressure / Illuminance / Flow / Occupancy / BooleanState |
| Power | ElectricalPowerMeasurement / ElectricalEnergyMeasurement |

All state arrives via the controller's sustained subscriptions (`ChangeNotificationService`)
and is pushed to the UI over SSE — no polling.

## IPv6 note (Linux hosts)

Thread devices are reached via mesh-local IPv6 through the OTBR. If commissioning succeeds but
the node never connects, check the host's IPv6 routing setup — see the matter.js
[troubleshooting guide](../docs/TROUBLESHOOTING.md#enabling-ipv6-thread-connectivity-on-linux-hosts).

## Security note

The hub serves its UI/API unauthenticated on the bind address (`0.0.0.0` by default) and keeps
the full Matter fabric (certificates, keys, Thread dataset) in local storage. Run it on a
trusted LAN or behind your own reverse proxy with auth; bind to `--host 127.0.0.1` to keep it
local-only.
