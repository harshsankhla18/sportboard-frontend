/**
 * Sportboard Dev Server — server.js
 *
 * Serves the frontend static files AND proxies API + WebSocket calls
 * to sportboard.onrender.com so the browser never hits CORS.
 *
 * Routes:
 *   /api/*  → https://sportboard.onrender.com/*   (HTTP proxy)
 *   /ws     → wss://sportboard.onrender.com/ws     (WS proxy)
 *   /*      → this directory/*                     (static files)
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = __dirname;
const BACKEND_HOST = 'sportboard.onrender.com';
const PORT = 3000;

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ── Proxy HTTP request ─────────────────────────────────────────
function proxyHttp(req, res, backendPath) {
  const options = {
    hostname: BACKEND_HOST,
    port: 443,
    path: backendPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: BACKEND_HOST,
      'x-forwarded-for': req.socket.remoteAddress,
    },
  };
  // Don't forward connection-level headers
  delete options.headers['connection'];

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'access-control-allow-origin': '*',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy error]', err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
  });

  req.pipe(proxyReq);
}

// ── Serve static file ──────────────────────────────────────────
function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(STATIC_DIR, urlPath);

  // Security: stay within static dir
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(STATIC_DIR, 'index.html'), (err2, html) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ── HTTP Server ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // OPTIONS preflight — always allow
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':  '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization',
    });
    res.end();
    return;
  }

  // /api/* → proxy to backend (strips /api prefix)
  if (req.url.startsWith('/api')) {
    const backendPath = req.url.replace(/^\/api/, '') || '/';
    console.log(`[proxy] ${req.method} ${req.url} → ${BACKEND_HOST}${backendPath}`);
    proxyHttp(req, res, backendPath);
    return;
  }

  // Static files
  serveStatic(req, res);
});

// ── WebSocket Proxy ────────────────────────────────────────────
server.on('upgrade', (req, clientSocket, head) => {
  if (req.url !== '/ws') {
    clientSocket.destroy();
    return;
  }

  console.log('[ws-proxy] upgrading client connection → wss://sportboard.onrender.com/ws');

  const backendSocket = net.createConnection(443, BACKEND_HOST, () => {
    // Send CONNECT tunnel for TLS — we can't tunnel raw TCP through TLS easily,
    // so instead we create a TLS socket directly
  });

  // Use TLS connect directly for the WS upgrade to the backend
  import('tls').then(({ connect }) => {
    const tlsSocket = connect({ host: BACKEND_HOST, port: 443, servername: BACKEND_HOST }, () => {
      // Forward the upgrade request
      const upgradeReq = [
        `GET /ws HTTP/1.1`,
        `Host: ${BACKEND_HOST}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}`,
        req.headers['sec-websocket-protocol']
          ? `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`
          : '',
        '',
        '',
      ].filter(Boolean).join('\r\n');

      tlsSocket.write(upgradeReq);
    });

    tlsSocket.on('error', (err) => {
      console.error('[ws-proxy tls error]', err.message);
      clientSocket.destroy();
    });

    // Pipe bidirectionally after the upgrade response passes through
    let upgraded = false;
    let buffer   = Buffer.alloc(0);

    tlsSocket.on('data', (chunk) => {
      if (upgraded) {
        clientSocket.write(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const str = buffer.toString();
      const headerEnd = str.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        upgraded = true;
        // Forward the 101 response + any data that followed
        clientSocket.write(buffer);
        buffer = Buffer.alloc(0);
      }
    });

    clientSocket.on('data', (chunk) => {
      if (tlsSocket.writable) tlsSocket.write(chunk);
    });

    clientSocket.on('end',   () => tlsSocket.destroy());
    clientSocket.on('error', () => tlsSocket.destroy());
    tlsSocket.on('end',   () => clientSocket.destroy());
    tlsSocket.on('close', () => clientSocket.destroy());
  });
});

// ── Start ──────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   SPORTBOARD DEV SERVER                      ║');
  console.log(`  ║   Frontend  →  http://localhost:${PORT}          ║`);
  console.log(`  ║   API Proxy →  http://localhost:${PORT}/api/...  ║`);
  console.log(`  ║   WS Proxy  →  ws://localhost:${PORT}/ws         ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});
