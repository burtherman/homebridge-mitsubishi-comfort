# Deployment Guide for Raspberry Pi

## Prerequisites
- Raspberry Pi with Homebridge already installed and running
- SSH access to your Pi
- Your Kumo Cloud credentials

## Option 1: Deploy via Git (Recommended)

### On your Mac:
```bash
# Push changes to your git remote (if you have one)
git push origin main
```

### On your Raspberry Pi:
```bash
# SSH into your Pi
ssh pi@your-pi-address

# Navigate to where you want to install
cd ~

# Clone or pull the repository
# If first time:
git clone <your-repo-url> homebridge-kumo-v3
cd homebridge-kumo-v3

# If updating existing:
cd homebridge-kumo-v3
git pull origin main

# Install dependencies
npm install

# Build TypeScript
npm run build

# Link plugin globally for Homebridge
sudo npm link
```

## Option 2: Deploy via SCP (No Git Remote)

### On your Mac:
```bash
# From the plugin directory
cd /path/to/homebridge-mitsubishi-comfort

# Create a clean tarball (excludes test files and node_modules)
tar -czf kumo-plugin.tar.gz \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='test-*.js' \
  --exclude='*.mitm' \
  src/ package.json package-lock.json tsconfig.json config.schema.json README.md

# Copy to your Pi (replace with your Pi's address)
scp kumo-plugin.tar.gz pi@your-pi-address:~/
```

### On your Raspberry Pi:
```bash
# SSH into your Pi
ssh pi@your-pi-address

# Extract the tarball
mkdir -p homebridge-kumo-v3
cd homebridge-kumo-v3
tar -xzf ../kumo-plugin.tar.gz

# Install dependencies
npm install

# Build TypeScript
npm run build

# Link plugin globally for Homebridge
sudo npm link
```

## Configure Homebridge

Edit your Homebridge config (usually at `~/.homebridge/config.json` or via the Homebridge UI):

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

**Security Note:** Consider using environment variables for credentials instead of hardcoding.

## Restart Homebridge

### If using systemd:
```bash
sudo systemctl restart homebridge
```

### If using hb-service:
```bash
sudo hb-service restart
```

### Check logs:
```bash
# For systemd
sudo journalctl -u homebridge -f

# For hb-service or manual
tail -f ~/.homebridge/homebridge.log
```

## Verify Installation

You should see in the logs:
```
[Kumo] Initializing platform: Kumo
[Kumo] Starting device discovery
[Kumo] Successfully logged in to Kumo Cloud API
[Kumo] Found 1 site(s)
[Kumo] Discovered device: Front bedroom (0Y34P008Q100142F)
[Kumo] Discovered device: Kitchen (9X34P008S100095F)
[Kumo] Discovered device: Living room (9534P008J100068F)
[Kumo] Discovered device: Middle bedroom (0Y34P008Q100172F)
[Kumo] Discovered device: Rear bedroom (9Z34P008J100245F)
[Kumo] Device discovery completed
```

## Check HomeKit

Open the Home app on your iPhone/iPad:
- All 5 heat pumps should appear as thermostats
- You should be able to:
  - See current temperature
  - Change target temperature
  - Switch between Off/Heat/Cool/Auto modes
  - See humidity (if available)

## Troubleshooting

### Plugin not discovered by Homebridge
```bash
# Verify the link
npm list -g homebridge-kumo-v3

# Re-link if needed
cd ~/homebridge-kumo-v3
sudo npm link
sudo systemctl restart homebridge
```

### Authentication errors
- Verify credentials in config.json
- Check Homebridge logs for specific error messages

### Devices not showing in HomeKit
- Check that devices are active in Kumo Cloud app
- Restart Homebridge
- Remove and re-add Home bridge in Home app (last resort)

### Status not updating
- Plugin polls every 30 seconds
- Check Homebridge logs for API errors
- Verify internet connectivity on Pi

## Uninstall (if needed)

```bash
# Unlink plugin
sudo npm unlink homebridge-kumo-v3 -g

# Remove files
rm -rf ~/homebridge-kumo-v3

# Remove from Homebridge config
# Edit ~/.homebridge/config.json and remove the KumoV3 platform entry

# Restart Homebridge
sudo systemctl restart homebridge
```

## What's Next

The plugin will:
- Poll for status updates every 30 seconds
- Use ETag caching to minimize bandwidth
- Automatically refresh authentication tokens
- Keep your HomeKit devices in sync with physical state

Enjoy your Brooklyn heating through HomeKit! 🏠❄️
