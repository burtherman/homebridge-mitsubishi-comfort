# Homebridge Mitsubishi Comfort

A Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API.

## ⚠️ Disclaimer

This plugin is not affiliated with, endorsed by, or associated with Mitsubishi Electric in any way. It is an independent, unofficial plugin developed by the community for personal use.

**Use at your own risk.** The author assumes no liability for any damage, data loss, or issues that may arise from using this plugin. By using this plugin, you acknowledge that you do so entirely at your own discretion and risk.

## Features

- **Intelligent streaming-first architecture** with automatic fallback
- **95% reduction in API calls** when streaming is healthy (optimal mode)
- **Real-time streaming updates** via Socket.IO for instant status changes
- **Adaptive polling** that activates only when streaming fails
- Full HomeKit thermostat integration
- Support for Heat, Cool, Auto, and Off modes
- Temperature control
- Current temperature and humidity display
- Automatic token refresh
- Multi-site and multi-zone support
- Device exclusion/hiding support
- Comprehensive logging for streaming/polling state transitions

## Installation

### Prerequisites

- Node.js (v14.18.1 or higher)
- Homebridge (v1.3.5 or higher)

### Install from NPM (once published)

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

- **Temperature Display Differences**: Mitsubishi and Apple use different Fahrenheit-to-Celsius conversion tables, which can cause temperature setpoints to display differently in each app:

  **When you set 70°F in Apple Home:**
  - HomeKit converts using standard math: 70°F → 21.111°C
  - Your unit is set to exactly 21.111°C (70.0°F)
  - Mitsubishi Comfort app may display this as ~69°F due to their custom conversion table

  **When you set 70°F in Mitsubishi Comfort app:**
  - Mitsubishi converts using their custom table: 70°F → 21.5°C (0.5°C increments)
  - Your unit is set to 21.5°C (which equals 70.7°F in standard conversion)
  - Apple Home displays this as 71°F (because 21.5°C = 70.7°F)

  **Both apps are technically correct** - they just use different conversion standards. The actual Celsius value sent to your unit is accurate in both cases. For consistency, pick one app for temperature control rather than mixing both.

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
6. **Control**: Changes made in HomeKit are sent to the Kumo Cloud API

### Update Strategy

The plugin uses a smart streaming-first approach with automatic fallback:

- **When streaming is healthy**: All device updates arrive via Socket.IO in real-time. If `disablePolling: true` is set, no polling occurs (optimal mode).
- **When streaming disconnects**: Plugin automatically switches to degraded mode with fast polling (default: 10s intervals) to ensure devices remain responsive.
- **When streaming reconnects**: Plugin automatically returns to normal mode, halting polling if `disablePolling: true`.
- **Race condition prevention**: Timestamp-based filtering ensures newer updates always take precedence, regardless of source.

## Supported Characteristics

- Current Temperature
- Target Temperature
- Current Heating/Cooling State
- Target Heating/Cooling State (Off, Heat, Cool, Auto)
- Temperature Display Units (Celsius/Fahrenheit)
- Current Relative Humidity (when available)

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
- All communication uses HTTPS encryption

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
