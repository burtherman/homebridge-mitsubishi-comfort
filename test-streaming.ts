import { io, Socket } from 'socket.io-client';
import fetch from 'node-fetch';

const SOCKET_BASE_URL = 'https://socket-prod.kumocloud.com';
const API_BASE_URL = 'https://app-prod.kumocloud.com/v3';
const APP_VERSION = '3.2.3';

interface DeviceUpdate {
  id: string;
  deviceSerial: string;
  rssi: number;
  power: number;
  operationMode: string;
  humidity: number | null;
  scheduleOwner: string;
  scheduleHoldEndTime: number;
  fanSpeed: string;
  airDirection: string;
  roomTemp: number;
  spCool: number;
  spHeat: number;
  spAuto: number | null;
  connected: boolean;
  previousOperationMode: string;
  lastStatusChangeAt: string;
  updatedAt: string;
  date: string;
}

async function login(username: string, password: string): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/login`, {
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

    if (!response.ok) {
      console.error('Login failed:', response.status);
      return null;
    }

    const data = await response.json() as any;
    console.log('Login successful');
    return data.token.access;
  } catch (error) {
    console.error('Login error:', error);
    return null;
  }
}

async function testStreaming(username: string, password: string) {
  console.log('=== Kumo Cloud Streaming API Test ===\n');

  // Step 1: Login to get access token
  console.log('Step 1: Logging in...');
  const accessToken = await login(username, password);
  if (!accessToken) {
    console.error('Failed to login');
    return;
  }
  console.log('Access token obtained\n');

  // Step 2: Connect to Socket.IO
  console.log('Step 2: Connecting to Socket.IO server...');
  console.log(`URL: ${SOCKET_BASE_URL}`);

  const socket: Socket = io(SOCKET_BASE_URL, {
    transports: ['polling', 'websocket'],
    auth: {
      token: accessToken,
    },
    extraHeaders: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  // Connection events
  socket.on('connect', () => {
    console.log('✓ Connected to Socket.IO server');
    console.log(`  Socket ID: ${socket.id}`);
    console.log(`  Transport: ${socket.io.engine.transport.name}\n`);
  });

  socket.on('connect_error', (error) => {
    console.error('✗ Connection error:', error.message);
  });

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${reason}`);
  });

  // Log all raw Socket.IO packets
  socket.io.engine.on('packet', (packet) => {
    console.log('\n[Raw Packet]', packet);
  });

  socket.io.engine.on('data', (data) => {
    console.log('\n[Raw Data]', data);
  });

  // Listen for device updates
  socket.on('device_update', (data: DeviceUpdate) => {
    console.log('\n--- Device Update Received ---');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Device: ${data.deviceSerial}`);
    console.log(`Mode: ${data.operationMode} (power: ${data.power})`);
    console.log(`Temperature: ${data.roomTemp}°C`);
    console.log(`Setpoints: Heat=${data.spHeat}°C, Cool=${data.spCool}°C, Auto=${data.spAuto}°C`);
    console.log(`Humidity: ${data.humidity}%`);
    console.log(`Fan Speed: ${data.fanSpeed}`);
    console.log(`Connected: ${data.connected}`);
    console.log(`RSSI: ${data.rssi} dBm`);
    console.log('---\n');
  });

  // Listen for any other events
  socket.onAny((eventName, ...args) => {
    console.log(`\n[Event: ${eventName}]`);
    console.log(JSON.stringify(args, null, 2));
  });

  // Keep the connection alive
  console.log('Listening for device updates... (Press Ctrl+C to exit)\n');

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    socket.disconnect();
    process.exit(0);
  });
}

// Run the test
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: node test-streaming.js <username> <password>');
  process.exit(1);
}

testStreaming(args[0], args[1]);
