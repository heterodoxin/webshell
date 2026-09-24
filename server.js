'use strict';

/*
 * Serves the static client and bridges each WebSocket tab to its own PTY.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.WEBSHELL_TOKEN || '';
const SHELL = process.env.WEBSHELL_SHELL || process.env.SHELL || '/bin/bash';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHUNK = 64 * 1024; // max payload per WS frame

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Live PTYs, so we can clean up on shutdown. */
const sessions = new Set();

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

const server = http.createServer(serveStatic);

/* ------------------------------------------------------------------ */
/* WebSocket <-> PTY bridge                                            */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (TOKEN && url.searchParams.get('token') !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const decoder = new StringDecoder('utf8');
  let p = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    sessions.delete(p);
    if (p) {
      try {
        p.kill();
      } catch { /* already gone */ }
    }
  };

  try {
    p = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: Object.assign({}, process.env, {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        WEBSHELL: '1',
      }),
    });
  } catch (err) {
    send(ws, { type: 'data', data: `\r\n\x1b[31mwebshell: failed to spawn shell: ${err.message}\x1b[0m\r\n` });
    send(ws, { type: 'exit', code: 1 });
    ws.close();
    return;
  }

  sessions.add(p);

  p.onData((raw) => {
    const text = typeof raw === 'string' ? raw : decoder.write(raw);
    if (!text || ws.readyState !== WebSocket.OPEN) return;
    // Split big bursts so no single frame gets unwieldy.
    for (let i = 0; i < text.length; i += CHUNK) {
      send(ws, { type: 'data', data: text.slice(i, i + CHUNK) });
    }
  });

  p.onExit(({ exitCode }) => {
    decoder.end();
    sessions.delete(p);
    send(ws, { type: 'exit', code: exitCode });
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!p) return;

    if (msg.type === 'input' && typeof msg.data === 'string') {
      if (msg.data.length <= 1024 * 1024) p.write(msg.data);
    } else if (msg.type === 'resize') {
      const cols = Math.min(600, Math.max(10, msg.cols | 0));
      const rows = Math.min(300, Math.max(4, msg.rows | 0));
      try {
        p.resize(cols, rows);
      } catch { /* pty may be dying */ }
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

/* ------------------------------------------------------------------ */
/* Startup / shutdown                                                  */
/* ------------------------------------------------------------------ */

/** Listen on PORT, stepping to the next free port if it's taken. */
function startListening(port, tries = 0) {
  // Listener pairs are managed manually because listen()'s callback survives failed attempts.
  const onOk = () => {
    server.removeListener('error', onErr);
    onListen(server.address().port);
  };
  const onErr = (err) => {
    server.removeListener('error', onErr);
    server.removeListener('listening', onOk);
    if (err.code === 'EADDRINUSE' && tries < 30) {
      console.log(`  port ${port} is busy — trying ${port + 1}…`);
      startListening(port + 1, tries + 1);
    } else {
      console.error(`cannot listen on ${HOST}:${port}: ${err.message}`);
      process.exit(1);
    }
  };
  server.once('listening', onOk);
  server.once('error', onErr);
  server.listen(port, HOST);
}

function onListen(port) {
  server.on('error', (err) => { console.error(err.message); process.exit(1); });
  console.log('');
  console.log('  \x1b[1;36mwebshell\x1b[0m is running');
  console.log('');
  console.log(`    local    http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${port}`);
  if (HOST === '127.0.0.1') {
    const login = process.env.USER || os.userInfo().username;
    console.log('    tunnel   ssh -N -L ' + port + ':127.0.0.1:' + port + ' ' + login + '@' + os.hostname());
  }
  if (TOKEN) console.log('    token    required (?token=...)');
  console.log(`    shell    ${SHELL}`);
  console.log('');
  console.log('  \x1b[33m!\x1b[0m whoever reaches this port gets a shell as your user.');
  console.log('');
}

startListening(PORT);

function shutdown() {
  console.log('\nshutting down…');
  for (const p of sessions) {
    try { p.kill(); } catch { /* ignore */ }
  }
  wss.clients.forEach((ws) => ws.terminate());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
