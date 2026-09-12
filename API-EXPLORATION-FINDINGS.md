# Kumo Cloud v3 API Exploration Findings

**Date:** December 25, 2025
**Plugin Version:** 1.3.0
**Goal:** Investigate if API can modify minimum temperature limits

---

## Executive Summary

**❌ Result:** The Kumo Cloud v3 API does **NOT** provide access to installer settings or the ability to modify temperature limits.

**Current Minimum:** 17°C (62.6°F) for heating mode
**Desired Minimum:** 12°C (54°F) or lower

---

## API Endpoints Discovered

### ✅ New Working Endpoints

1. **`GET /config`** - Returns general configuration
   ```json
   {
     "timeBeforeDisable": 30,
     "notificationRateLimit": 86400000,
     "batteryNotificationRateLimit": 172800000,
     "temperatureNotificationRateLimit": 1800000,
     "notificationArchivingEnabled": true,
     "notificationArchivingCheckIntervalHours": 6,
     "notificationArchivingBatchSize": 500
   }
   ```

2. **`GET /devices/{serial}/profile`** - Returns device capabilities and limits ⭐
   ```json
   {
     "hasModeDry": true,
     "hasModeHeat": true,
     "hasVaneDir": false,
     "hasVaneSwing": false,
     "hasModeVent": true,
     "hasFanSpeedAuto": true,
     "hasInitialSettings": false,
     "hasModeTest": true,
     "numberOfFanSpeeds": 3,
     "extendedTemps": true,
     "usesSetPointInDryMode": true,
     "hasHotAdjust": true,
     "hasDefrost": true,
     "hasStandby": true,
     "maximumSetPoints": {
       "cool": 30,
       "heat": 28,
       "auto": 28
     },
     "minimumSetPoints": {
       "cool": 19,
       "heat": 17,    ← Current minimum limit
       "auto": 19
     }
   }
   ```

### ❌ Endpoints That Don't Exist

- `/installer/login`
- `/admin/login`
- `/technician/login`
- `/devices/{serial}/settings`
- `/devices/{serial}/config`
- `/devices/{serial}/installer`
- `/devices/{serial}/functioncodes`
- `/sites/{siteId}/settings`
- `/functioncodes`
- `/limits`
- `/ranges`

### 🔒 Read-Only Endpoints

- `/devices/{serial}/profile` - Returns data but rejects PUT/PATCH/POST (404)

---

## API Command Validation

When attempting to set temperature below minimum (15°C / 59°F):

```json
Request:
POST /devices/send-command
{
  "deviceSerial": "0Y34P008Q100142F",
  "commands": { "spHeat": 15 }
}

Response: 400 Bad Request
{
  "error": {
    "0Y34P008Q100142F": {
      "commands": ["invalidSpHeatRange"]
    }
  },
  "description": "Failed to validate commands"
}
```

**Error Code:** `invalidSpHeatRange` - Confirms API-level validation of temperature limits.

---

## Login Variants Tested

### Standard Login Parameters
- ✅ `username`, `password`, `appVersion` - Works
- ❌ `role: 'installer'` - Ignored
- ❌ `userType: 'installer'` - Ignored
- ❌ `accountType: 'installer'` - Ignored
- ❌ `installerPin: '9999'` - Ignored

### Alternative Endpoints
- ❌ `/installer/login` - Does not exist (404)
- ❌ `/admin/login` - Does not exist (404)
- ❌ `/technician/login` - Does not exist (404)

**Conclusion:** No installer-level authentication available via API.

---

## Device Information

**Models Tested:**
- PEFY-P12NMAU-E3 (12k BTU ducted)
- PEFY-P18NMAU-E3 (18k BTU ducted)

**MHK2 Status:** `hasMhk2: false` (no MHK2 controllers installed)

**Current Configuration:**
- Minimum Heat: 17°C (62.6°F)
- Maximum Heat: 28°C (82.4°F)
- Minimum Cool: 19°C (66.2°F)
- Maximum Cool: 30°C (86°F)

---

## Alternative Solutions Researched

### Via MHK2 Controller (Requires Hardware Purchase)
**Function Code 181** allows setting minimum temperature as low as 10°C (50°F).

**Access Method:**
1. Purchase MHK2 wall thermostat ($200-300)
2. Access Menu → Setup → Function Code 181
3. Set minimum to desired value

**Installer PIN:** Default is date code on back of unit + 1234, or access via Menu → Screen Lock → Full Lock → Select (displays PIN)

### Via Smart Set Feature
Available on some Mitsubishi remotes, allows either 50°F or 61°F minimum (no values in between).

### Via HVAC Installer
Professional installers can access function codes directly on the unit without additional hardware.

---

## Plugin Enhancements Made

### ✅ Enhanced Logging (Always Active)
Added comprehensive logging that works regardless of debug mode:

**Mode Changes:**
```
[MODE CHANGE] Front bedroom: HomeKit sent HEAT mode
[MODE CHANGE] Front bedroom: Command accepted by API
```

**Temperature Changes:**
```
[TEMP CHANGE] Living room: HomeKit sent 21.100°C (70.0°F)
[TEMP CHANGE] Living room: Sending to API: {"spHeat":21.1}°C
[TEMP CHANGE] Living room: Command accepted by API
```

**API Errors:**
```
Request failed with status: 400
Error response: {"error":{"0Y34P008Q100142F":{"commands":["invalidSpHeatRange"]}},"description":"Failed to validate commands"}
```

### Code Changes Made
1. `src/kumo-api.ts:284-291` - Always log 400 error responses
2. `src/accessory.ts:326-372` - Add mode change logging with human-readable mode names
3. Existing temperature change logging already in place

---

## Recommendations

### Immediate Options
1. **Contact HVAC Installer** (Recommended) - Can adjust Function Code 181 remotely or on-site
2. **Purchase MHK2 Controller** - Provides permanent access to all function codes
3. **Accept Current Limits** - 17°C (62.6°F) is within Mitsubishi's standard operating range

### Long-Term Solution
Install MHK2 wall thermostat for full control over:
- Function codes
- Temperature limits
- Advanced scheduling
- Direct unit control without cloud dependency

---

## References

### Research Sources
- [GreenBuildingAdvisor: Mitsubishi 50°F Settings](https://www.greenbuildingadvisor.com/question/can-mitsubishi-heat-pumps-be-set-to-heat-to-50-degrees)
- [HVAC-Talk: Mitsubishi Temperature Limits](https://www.hvac-talk.com/threads/mitsubishi-unit-wont-let-me-lower-the-temp-below-67.2250145/)
- [The Garage Journal: Mini-Split Low Setpoints](https://www.garagejournal.com/forum/threads/mini-split-that-heats-to-below-60f-set-points.393342/)

### Community Projects
- [dlarrick/pykumo](https://github.com/dlarrick/pykumo) - Python library for local API
- [dlarrick/hass-kumo](https://github.com/dlarrick/hass-kumo) - Home Assistant integration

---

## Technical Notes

### API Rate Limiting
The Kumo Cloud API implements rate limiting on login attempts. Multiple rapid login requests result in:
```json
{
  "error": "usernameOrPasswordIncorrect"
}
```
Even with valid credentials. Wait 15-30 minutes between testing sessions.

### Token Management
- Access tokens expire after ~20 minutes
- Plugin auto-refreshes at 15-minute mark
- Refresh tokens used to obtain new access tokens
- Full re-login if refresh fails

### Streaming Connection
- Socket.IO connection to `socket-prod.kumocloud.com`
- Real-time device updates via `device_update` events
- Health monitoring with automatic fallback to polling
- 95% reduction in API calls when streaming is healthy

### Socket.IO Streaming Events

The following events are available on the Socket.IO connection. Field documentation sourced from
[dlarrick/hass-kumo](https://github.com/dlarrick/hass-kumo) and the related
[EnumC/ha_kumo_ws](https://github.com/EnumC/ha_kumo_ws) (V3 cloud API integration) and
[dlarrick/pykumo](https://github.com/dlarrick/pykumo) (`Cloud_api_v3.md`).

#### `device_update`
Primary device state event. Sent when device state changes and on initial subscription.

**Key Fields:**
```json
{
  "id": "string",
  "deviceSerial": "string",
  "roomTemp": 21.5,
  "spHeat": 20,
  "spCool": 24,
  "spAuto": null,
  "power": 1,
  "operationMode": "heat",
  "previousOperationMode": "heat",
  "fanSpeed": "auto",
  "airDirection": "auto",
  "humidity": 45,
  "rssi": -55,
  "connected": true,
  "modelNumber": "SVZ-KP30NA",
  "displayConfig": {
    "filter": false,
    "defrost": false,
    "hotAdjust": false,
    "standby": false
  },
  "isSimulator": false,
  "ledDisabled": false,
  "isHeadless": false,
  "scheduleOwner": "adapter",
  "scheduleHoldEndTime": 0,
  "activeThermistor": "string",
  "tempSource": "string",
  "twoFiguresCode": "string",
  "unusualFigures": "string",
  "statusDisplay": "string",
  "runTest": "string",
  "lastStatusChangeAt": "ISO 8601",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601",
  "timeZone": "string"
}
```

**`displayConfig` field mapping (V3 cloud vs local API):**
| V3 Cloud / Streaming | Local API (pykumo) | Description |
|----------------------|-------------------|-------------|
| `displayConfig.filter` | `indoorUnit.status.filterDirty` | Filter needs cleaning |
| `displayConfig.defrost` | `indoorUnit.status.defrost` | Defrost cycle active |
| `displayConfig.standby` | `indoorUnit.status.standby` | Compressor idle / standby |
| `displayConfig.hotAdjust` | — | Hot adjust active |

#### `device_status_v2`
Connection status for devices. Sent in response to `device_status_v2` emit.

```json
{
  "deviceSerial": "string",
  "status": "connected",
  "lastTimeConnected": "ISO 8601",
  "lastDisconnectedReason": "string"
}
```

Status values: `"connected"` or `"disconnected"`.

#### `profile_update`
Device capability profile. Sent in response to `force_adapter_request(serial, 'profile')`.

```json
{
  "deviceSerial": "string",
  "numberOfFanSpeeds": 3,
  "hasFanSpeedAuto": true,
  "hasModeDry": true,
  "hasModeHeat": true,
  "hasModeVent": true,
  "hasVaneDir": false,
  "hasVaneSwing": false,
  "hasDefrost": true,
  "hasStandby": true,
  "hasHotAdjust": true,
  "hasInitialSettings": false,
  "hasModeTest": true,
  "extendedTemps": true,
  "usesSetPointInDryMode": true,
  "minimumSetPoints": { "cool": 19, "heat": 17, "auto": 19 },
  "maximumSetPoints": { "cool": 30, "heat": 28, "auto": 28 }
}
```

#### `adapter_update`
Adapter hardware info. Sent in response to `force_adapter_request(serial, 'adapterStatus')`.

```json
{
  "deviceSerial": "string",
  "firmwareVersion": "string",
  "routerRssi": -55,
  "password": "REDACTED",
  "minSetpoint": 17,
  "maxSetpoint": 28,
  "roomTempDisplayOffset": 0
}
```

**Note:** Contains the unit's local-API password — always strip before logging.

> **⚠️ Out of date as of ~2026-08-01.** Mitsubishi removed `password` from this event.
> It still fires, and still carries everything else, but the secret is gone — and
> `firmwareVersion` here now reads `"00.00.00"` while `/devices/{serial}/status` reports
> the real value for the same unit at the same moment. `GET /devices/{serial}/status`
> stopped returning `cryptoSerial` in the same window.
>
> The legacy v2 endpoint still serves both secrets. Full account, timeline and
> verification recipes: **`docs/LOCAL-CREDENTIAL-SOURCES.md`**.

#### `acoil_update`
Minimal event for A-coil (outdoor unit) data.

```json
{
  "deviceSerial": "string",
  "date": "ISO 8601"
}
```

### Socket.IO Client Emits

| Emit | Arguments | Description |
|------|-----------|-------------|
| `subscribe` | `(deviceSerial)` | Subscribe to device updates |
| `subscribe` | `('', userId)` | Account-level subscribe (needed for `adapter_update`) |
| `force_adapter_request` | `(deviceSerial, 'iuStatus')` | Request indoor unit status |
| `force_adapter_request` | `(deviceSerial, 'profile')` | Request device profile |
| `force_adapter_request` | `(deviceSerial, 'adapterStatus')` | Request adapter hardware info |
| `device_status_v2` | `(deviceSerial)` | Request device connection status |
| `device_status_v2` | `('')` | Request all device connection statuses |

---

## Conclusion

While we successfully discovered the API endpoint that exposes temperature limits (`/devices/{serial}/profile`), the Kumo Cloud v3 API is designed as a read-only interface for device capabilities. All installer-level settings, including Function Code 181 for temperature limits, must be configured through:

1. Physical access to the unit
2. MHK2 wall controller
3. Professional HVAC installer service

**The API cannot and will not allow modification of these safety-critical settings.**

For users requiring lower minimum temperatures, the recommended path is purchasing an MHK2 controller or contacting a Mitsubishi-certified installer.

---

**End of Report**
