// keepalive.js
// Prevents Render free-tier cold starts by self-pinging every 13 minutes.
// Render spins down after 15 min of inactivity — we ping at 13 to stay warm.
//
// In server.js add at the bottom:
//   require('./keepalive');

const https = require('https');
const http  = require('http');

const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || process.env.VITE_API_URL || null;
const INTERVAL_MS = 13 * 60 * 1000; // 13 minutes

function ping() {
  if (!BACKEND_URL) return; // don't ping in local dev

  const url = `${BACKEND_URL}/api/ping`;
  const lib = url.startsWith('https') ? https : http;

  lib.get(url, (res) => {
    console.log(`[keepalive] ping → ${res.statusCode}`);
  }).on('error', (err) => {
    console.warn('[keepalive] ping failed:', err.message);
  });
}

// First ping after 1 minute (give server time to start), then every 13 min
setTimeout(() => {
  ping();
  setInterval(ping, INTERVAL_MS);
}, 60_000);

console.log('[keepalive] Render warmup active — pinging every 13 min');
