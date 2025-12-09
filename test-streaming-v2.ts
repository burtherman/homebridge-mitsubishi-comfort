import { io, Socket } from 'socket.io-client';
import fetch from 'node-fetch';

const SOCKET_BASE_URL = 'https://socket-prod.kumocloud.com';
const API_BASE_URL = 'https://app-prod.kumocloud.com/v3';
const APP_VERSION = '3.2.3';

async function testStreamingWithFreshLogin(username: string, password: string) {
  console.log('=== Kumo Cloud Streaming API Test v2 ===\n');

  // Step 1: Login
  console.log('Step 1: Logging in...');
  const loginResponse = await fetch(`${API_BASE_URL}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-App-Version': APP_VERSION,
    },
    body: JSON.stringify({
      username,
      password,
      appVersion: APP_VERSION,
    }),
  });

  if (!loginResponse.ok) {
    console.error('Login failed:', loginResponse.status);
    return;
  }

  const loginData = await loginResponse.json() as any;
  const accessToken = loginData.token.access;
  console.log('✓ Login successful');
  console.log(`  User ID: ${loginData.id}`);
  console.log(`  Token (first 50 chars): ${accessToken.substring(0, 50)}...`);

  // Decode JWT to see expiration
  const tokenParts = accessToken.split('.');
  const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
  console.log(`  Token issued at: ${new Date(payload.iat * 1000).toISOString()}`);
  console.log(`  Token expires at: ${new Date(payload.exp * 1000).toISOString()}`);
  console.log();

  // Step 2: Connect to Socket.IO IMMEDIATELY after login
  console.log('Step 2: Connecting to Socket.IO (immediately after login)...');

  const socket: Socket = io(SOCKET_BASE_URL, {
    transports: ['polling', 'websocket'],
    extraHeaders: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': '*/*',
      'User-Agent': 'kumocloud/1122',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Log all packets
  socket.io.engine.on('packet', (packet: any) => {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Packet:`, JSON.stringify(packet));

    // If this is a message packet, decode it
    if (packet.type === 'message' && packet.data) {
      const data = packet.data.toString();
      console.log(`  Decoded: ${data}`);

      // Check for notAuthorized
      if (data.includes('notAuthorized')) {
        console.error('  ⚠️  AUTHORIZATION FAILED!');
      }

      // Check for device_update
      if (data.includes('device_update')) {
        console.log('  ✓ DEVICE UPDATE RECEIVED!');
        try {
          // Parse the Socket.IO message format: 42["event_name", {...data}]
          const match = data.match(/42\["device_update",(.+)\]/);
          if (match) {
            const deviceData = JSON.parse(match[1]);
            console.log(`    Device: ${deviceData.deviceSerial}`);
            console.log(`    Temp: ${deviceData.roomTemp}°C`);
            console.log(`    Mode: ${deviceData.operationMode} (power: ${deviceData.power})`);
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  });

  socket.on('connect', async () => {
    console.log(`\n✓ Connected to Socket.IO`);
    console.log(`  Socket ID: ${socket.id}`);
    console.log(`  Transport: ${socket.io.engine.transport.name}`);

    // Step 3: Subscribe to device (hardcoded for testing)
    console.log('\nStep 3: Subscribing to device...');

    // Hardcoded device serial from your mitmweb logs
    const deviceSerial = '0Y34P008Q100142F';
    console.log(`  Subscribing to: ${deviceSerial}`);
    socket.emit('subscribe', deviceSerial);
    console.log('✓ Subscribe message sent')
  });

  socket.on('connect_error', (error) => {
    console.error(`\n✗ Connection error: ${error.message}`);
  });

  socket.on('disconnect', (reason) => {
    console.log(`\n✗ Disconnected: ${reason}`);
  });

  // Listen for device updates
  socket.on('device_update', (data: any) => {
    console.log('\n=== DEVICE UPDATE EVENT ===');
    console.log(JSON.stringify(data, null, 2));
  });

  // Listen for any events
  socket.onAny((eventName, ...args) => {
    console.log(`\n[Event: ${eventName}]`);
    console.log(JSON.stringify(args, null, 2));
  });

  console.log('\nListening for events... (Press Ctrl+C to exit)\n');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    socket.disconnect();
    process.exit(0);
  });
}

// Run
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: node test-streaming-v2.js <username> <password>');
  process.exit(1);
}

testStreamingWithFreshLogin(args[0], args[1]);
