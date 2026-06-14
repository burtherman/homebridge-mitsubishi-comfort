# Homebridge Mitsubishi Comfort

A Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API.

## ⚠️ Disclaimer

This plugin is not affiliated with, endorsed by, or associated with Mitsubishi Electric in any way. It is an independent, unofficial plugin developed by the community for personal use.

**Use at your own risk.** The author assumes no liability for any damage, data loss, or issues that may arise from using this plugin. By using this plugin, you acknowledge that you do so entirely at your own discretion and risk.

## Features

- **Local LAN control (opt-in)** — control and read each unit directly over your network, with automatic per-unit cloud fallback ([details](#local-lan-control))
- **Intelligent streaming-first architecture** with automatic fallback
- **95% reduction in API calls** when streaming is healthy (optimal mode)
- **Real-time streaming updates** via Socket.IO for instant status changes
- **Adaptive polling** that activates only when streaming fails
- Full HomeKit thermostat integration — Heat, Cool, Auto, and Off
- **Auto-mode temperature range** — a two-handle heat/cool band in HomeKit's Auto mode
- **Fan-only and Dry (dehumidify) modes** — exposed as per-unit switches (HomeKit's thermostat has no state for them)
- **0.1°C setpoint resolution** for faithful °F round-tripping between Home and the Kumo app
- Current temperature and humidity display, plus a filter-change indicator
- Automatic token refresh
- Multi-site and multi-zone support
- Device exclusion/hiding support
- Comprehensive logging for streaming/polling/local state transitions

## Installation

### Prerequisites

- Node.js (v18.0.0 or higher)
- Homebridge (v1.6.0 or higher, including v2.x)

### Install from NPM

```bash
npm install -g homebridge-mitsubishi-comfort
```

### Install from Source

```bash
git clone https://github.com/burtherman/homebridge-mitsubishi-comfort.git
cd homebridge-mitsubishi-comfort
npm install
npm run build
npm link
```

## Configuration

Add the following to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "KumoV3",
      "name": "Kumo",
      "username": "your-email@example.com",
      "password": "your-password"
    }
  ]
}
```

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `platform` | string | Yes | Must be `KumoV3` |
| `name` | string | No | Platform name (default: "Kumo") |
| `username` | string | Yes | Your Kumo Cloud email address |
| `password` | string | Yes | Your Kumo Cloud password |
| `pollInterval` | number | No | Polling interval when streaming is healthy in seconds (default: 30, minimum: 5) |
| `disablePolling` | boolean | No | **Recommended:** Disable polling when streaming is healthy (auto-enables if streaming fails, default: false) |
| `degradedPollInterval` | number | No | Fast polling interval when streaming is unhealthy in seconds (default: 10, minimum: 5, maximum: 60) |
| `streamingHealthCheckInterval` | number | No | How often to check if streaming is healthy in seconds (default: 30, minimum: 10, maximum: 300) |
| `streamingStaleThreshold` | number | No | Consider streaming stale if no updates received for this long in seconds (default: 60, minimum: 30, maximum: 600) |
| `excludeDevices` | string[] | No | Array of device serial numbers to hide from HomeKit |
| `debug` | boolean | No | Enable debug logging (default: false) |
| `localControl` | boolean | No | **Opt-in (default: false).** Control units directly over the LAN; cloud stays for discovery/credentials and as a per-unit fallback. See [Local LAN Control](#local-lan-control) |
| `localPollInterval` | number | No | Seconds between local status polls when `localControl` is on (default: 15, minimum: 5, maximum: 120) |
| `localControlIps` | object | No | Optional `{ "<deviceSerial>": "<ip>" }` map to skip LAN discovery for specific units |

### Recommended Configuration for Optimal Efficiency

For best performance and minimal network traffic, enable streaming-only mode:

```json
{
  "platforms": [
    {
      "platform": "KumoV3",
      "name": "Kumo",
      "username": "your-email@example.com",
      "password": "your-password",
      "disablePolling": true
    }
  ]
}
```

This configuration:
- Uses streaming for all device updates when healthy (0 polling queries)
- Automatically activates 10-second polling if streaming disconnects
- Reduces API calls by ~95% (from ~257/hour to ~12/hour)
- Only makes token refresh queries every 15 minutes during normal operation

### Debug Mode

When `debug: true` is enabled, the plugin will log detailed information including:

- API requests and responses with timing information
- Raw JSON data from zone/device API responses showing all available fields
- Real-time streaming updates with complete device state
- Authentication and token refresh events
- WebSocket connection status

**Note:** Debug mode may log sensitive information and should only be enabled for troubleshooting. The plugin will display a warning when debug mode is active.

### Known Limitations

- **Outdoor Temperature**: The Kumo Cloud API does not expose outdoor temperature data from the outdoor units. While outdoor units have temperature sensors (used for defrost cycles), this data is only available through direct CN105 serial connections, not through the cloud API.

- **Temperature Display Differences (°F)**: HomeKit stores temperatures in Celsius and converts to °F for display, while the units operate in 0.5°C steps. This can make the same value show as e.g. 72°F in one app and 73°F in the other.

  **Setpoints:** the plugin uses a **0.1°C step** so a value you set in the Home app stores a Celsius value that round-trips back to the same °F — largely eliminating the setpoint mismatch. (The units accept finer-than-0.5°C setpoints; this was verified against real hardware.) Note this only refines *new* changes you make in HomeKit; existing setpoints keep whatever value they were last set to.

  **Current temperature:** the indoor units report their measured room temperature only in **0.5°C steps** (a hardware limit), so the displayed current temperature can still differ by ~1°F between apps. There's no setting that changes this — it's the resolution the unit reports.

## Local LAN Control

By default the plugin controls your units through the Kumo Cloud. With `localControl: true`, it instead talks **directly to each indoor unit's WiFi adapter over your LAN** — lower latency, no cloud rate limits, and it keeps working during a cloud outage. This mirrors Home Assistant's official `mitsubishi_comfort` integration.

```json
{
  "platform": "KumoV3",
  "username": "your-email@example.com",
  "password": "your-password",
  "disablePolling": true,
  "localControl": true
}
```

**How it works:**

- The cloud is still used once at startup for **discovery and credentials** (each unit's local password and key). The plugin then **discovers each unit's IP** by sweeping your local subnet — no manual setup required.
- Commands go **local-first with automatic cloud fallback**: if a unit isn't reachable locally, that unit transparently uses the cloud.
- Status is read by **local polling** (`localPollInterval`, default 15s). Cloud streaming stays connected as the fallback.
- It's **per-unit and self-healing** — a unit on a different VLAN, or one that's temporarily unreachable, just uses the cloud.

**Requirements & notes:**

- Your Homebridge host must be on the **same network** as the units (a routable subnet). VLAN-segmented IoT networks will fall back to cloud.
- Optional: set `localControlIps` to a `{ "<serial>": "<ip>" }` map to skip discovery (e.g. if you've assigned static IPs).
- **Toggling `localControl` requires a full Homebridge restart**, not just a child-bridge restart — child bridges receive their config from the main process.
- Local control is currently marked experimental; if anything misbehaves, set `localControl: false` to return to pure cloud.

## HomeKit Modes & Switches

HomeKit's thermostat service only models Off / Heat / Cool / Auto, so some unit features are surfaced differently:

- **Auto mode shows a temperature range.** In Auto, the Home app presents a two-handle band — the lower handle is the heat setpoint, the upper is the cool setpoint (via `HeatingThresholdTemperature` / `CoolingThresholdTemperature`).
- **Fan-only** is a separate **"Fan" switch** per unit (added only on units that support vent mode). On = fan only; off = the unit powers down.
- **Dry (dehumidify)** is a separate **"Dry" switch** per unit (added only on units that support dry mode). On units that support a dry setpoint, the thermostat's target temperature controls it. Fan and Dry are mutually exclusive.
- **Filter indicator.** A filter-change indication appears when the unit reports its filter needs cleaning.

> **Note:** HomeKit caches an accessory's services. If a newly-supported switch or the Auto range doesn't appear after an update, reboot your Home hub (Apple TV/HomePod) or the iOS device to refresh its cache.

## Development

### Build

```bash
npm run build
```

### Watch for Changes

```bash
npm run watch
```

This will compile TypeScript, link the plugin, and restart on changes.

## How It Works

1. **Authentication**: The plugin logs in to the Kumo Cloud v3 API using your credentials
2. **Token Management**: Access tokens are automatically refreshed every 15 minutes
3. **Discovery**: All sites and zones are discovered and registered as HomeKit thermostats
4. **Real-time Streaming**: Establishes Socket.IO connection for instant device updates
5. **Intelligent Fallback**:
   - **Normal Mode** (streaming healthy): Updates via streaming only, minimal API calls
   - **Degraded Mode** (streaming failed): Automatic fallback to fast polling (10s intervals)
   - **Health Monitoring**: Continuous checking of streaming connection status
   - **Automatic Recovery**: Returns to streaming-only mode when connection restored
6. **Control**: Changes made in HomeKit are sent to the unit — directly over the LAN when `localControl` is enabled and the unit is reachable, otherwise via the Kumo Cloud API

### Update Strategy

The plugin uses a smart streaming-first approach with automatic fallback:

- **When streaming is healthy**: All device updates arrive via Socket.IO in real-time. If `disablePolling: true` is set, no polling occurs (optimal mode).
- **When streaming disconnects**: Plugin automatically switches to degraded mode with fast polling (default: 10s intervals) to ensure devices remain responsive.
- **When streaming reconnects**: Plugin automatically returns to normal mode, halting polling if `disablePolling: true`.
- **Race condition prevention**: Timestamp-based filtering ensures newer updates always take precedence, regardless of source.

## Supported Characteristics

- Current Temperature
- Target Temperature (0.1°C step)
- Heating / Cooling Threshold Temperature (the two-handle Auto range)
- Current Heating/Cooling State
- Target Heating/Cooling State (Off, Heat, Cool, Auto)
- Current Relative Humidity (when the unit has a sensor)
- Filter Change Indication (when reported)
- "Fan" and "Dry" switches (per unit, capability-gated)

## API Endpoints Used

### REST API
- `POST /v3/login` - Authentication
- `GET /v3/sites` - Get all sites
- `GET /v3/sites/{siteId}/zones` - Get zones for a site
- `GET /v3/devices/{deviceSerial}/status` - Get device status
- `POST /v3/devices/send-command` - Send commands to device

### Socket.IO Streaming
- `wss://socket-prod.kumocloud.com` - Real-time device updates via Socket.IO
- Emits `subscribe` event with device serial to receive updates
- Receives `device_update` events with full device state
- Receives `adapter_update` events (used to obtain each unit's local credentials for local control)

### Local LAN (when `localControl` is enabled)
- `PUT http://<unit-ip>/api?m=<token>` - direct status reads and commands to each indoor unit's WiFi adapter (no cloud)

## Security

### Best Practices

- **Credentials**: Your Kumo Cloud credentials are stored in the Homebridge config file. Ensure this file has appropriate permissions (readable only by the Homebridge user).
- **Debug Mode**: Only enable debug mode when troubleshooting. Debug logs may contain sensitive information like API endpoints and error details.
- **Network**: This plugin communicates with Kumo Cloud servers over HTTPS. Ensure your Homebridge instance runs in a secure network environment.
- **Updates**: Keep the plugin updated to receive security patches.

### What Data is Transmitted

- Authentication credentials (username/password) are sent to Kumo Cloud API during login
- Device commands and status updates are exchanged with Kumo Cloud servers
- No data is transmitted to third parties
- Cloud communication uses HTTPS encryption
- With `localControl` enabled, commands and status are also exchanged **directly with the units on your LAN** over plain HTTP (the units' local API is not encrypted; this stays within your network)

## Troubleshooting

### Plugin not discovering devices

- Verify your username and password are correct
- Check Homebridge logs for authentication errors
- Ensure your Kumo Cloud account has active devices

### Devices not responding to commands

- Check your internet connection
- Verify devices are online in the Kumo Cloud app
- Check Homebridge logs for API errors

### Temperature not updating

- Status is polled every 30 seconds by default
- Ensure the device is connected (check in Kumo Cloud app)
- Look for polling errors in Homebridge logs

## License

Apache License 2.0

Copyright 2024

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

## Credits

Based on the Kumo Cloud v3 API and inspired by [homebridge-kumo](https://github.com/fjs21/homebridge-kumo).
