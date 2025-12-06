# Homebridge Kumo v3 Plugin

A Homebridge plugin for Mitsubishi heat pumps using the Kumo Cloud v3 API.

## Features

- Full HomeKit thermostat integration
- Support for Heat, Cool, Auto, and Off modes
- Temperature control
- Current temperature and humidity display
- Automatic token refresh
- Status polling every 30 seconds
- Multi-site and multi-zone support

## Installation

### Prerequisites

- Node.js (v14.18.1 or higher)
- Homebridge (v1.3.5 or higher)

### Install from NPM (once published)

```bash
npm install -g homebridge-kumo-v3
```

### Install from Source

```bash
git clone https://github.com/yourusername/homebridge-kumo-v3.git
cd homebridge-kumo-v3
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
4. **Polling**: Device status is polled every 30 seconds to keep HomeKit in sync
5. **Control**: Changes made in HomeKit are sent to the Kumo Cloud API

## Supported Characteristics

- Current Temperature
- Target Temperature
- Current Heating/Cooling State
- Target Heating/Cooling State (Off, Heat, Cool, Auto)
- Temperature Display Units (Celsius/Fahrenheit)
- Current Relative Humidity (when available)

## API Endpoints Used

- `POST /v3/login` - Authentication
- `GET /v3/sites` - Get all sites
- `GET /v3/sites/{siteId}/zones` - Get zones for a site
- `GET /v3/devices/{deviceSerial}/status` - Get device status
- `POST /v3/devices/send-command` - Send commands to device

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

MIT

## Credits

Based on the Kumo Cloud v3 API and inspired by [homebridge-kumo](https://github.com/fjs21/homebridge-kumo).
