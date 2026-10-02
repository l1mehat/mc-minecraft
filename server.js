'use strict';
/* ====================================================================
   PocketMC – serwer (HTTP + WebSocket, czysty Node.js, bez zależności)
   Uruchomienie:  node server.js        (domyślnie http://localhost:3000)
   Zmiana portu:  PORT=8080 node server.js
   Serwer:  - wysyła grę (index.html),
            - synchronizuje graczy, bloki, czat, czas dnia i moby,
            - zapisuje zmiany świata do world.json.
   ==================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const SAVE_FILE = path.join(__dirname, 'world.json');
const DAY_SECONDS = 1200;

let world = { seed: Math.floor(Math.random() * 2e9), time: 0.08, blocks: {} };
try {
  world = Object.assign(world, JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')));
  console.log('[świat] wczytano world.json (ziarno ' + world.seed + ', zmienionych bloków: ' + Object.keys(world.blocks).length + ')');
} catch (e) {
  console.log('[świat] nowy świat, ziarno ' + world.seed);
}
let dirty = false;
let lastTick = Date.now();

function currentTime() {
  return world.time;
}
setInterval(() => {
  const now = Date.now();
  world.time = (world.time + (now - lastTick) / 1000 / DAY_SECONDS) % 1;
  lastTick = now;
}, 1000);

function saveWorld() {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(SAVE_FILE, JSON.stringify(world), err => {
    if (err) { console.error('[świat] błąd zapisu:', err.message); dirty = true; }
  });
}
setInterval(saveWorld, 20000);

/* ------------------------- HTTP: pliki statyczne ------------------------- */
function findFile(name) {
  const candidates = [path.join(__dirname, name), path.join(__dirname, 'public', name)];
  if (name === 'three.min.js') candidates.push(path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '/index.html') url = '/index.html';
  else if (url !== '/three.min.js') { res.writeHead(404); res.end('Not found'); return; }
  const file = findFile(url.slice(1));
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

/* ------------------------- minimalny WebSocket (RFC 6455) ------------------------- */
const clients = new Map();
let nextId = 1;
let mobHostId = null;
let lastMobs = [];

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function send(c, obj) {
  if (c.socket.destroyed || !c.ready) return;
  try { c.socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); } catch (e) { /* ignore */ }
}
function broadcast(obj, except) {
  const data = frame(1, Buffer.from(JSON.stringify(obj)));
  for (const c of clients.values()) {
    if (c === except || !c.ready || c.socket.destroyed) continue;
    try { c.socket.write(data); } catch (e) { /* ignore */ }
  }
}

function assignMobHost(exclude) {
  if (mobHostId !== null) {
    const cur = clients.get(mobHostId);
    if (cur && cur.ready && cur !== exclude) return; // obecny host wciąż aktywny
  }
  let chosen = null;
  for (const c of clients.values()) {
    if (c.ready && c !== exclude) { chosen = c; break; }
  }
  if (chosen) {
    mobHostId = chosen.id;
    send(chosen, { t: 'mobHost', value: true, mobs: lastMobs });
    console.log('[moby] nowy host mobów: ' + chosen.name + ' (#' + chosen.id + ')');
  } else {
    mobHostId = null;
    lastMobs = [];
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { id: 0, name: '', socket, buf: Buffer.alloc(0), frag: [], ready: false, x: 0, y: 80, z: 0, yaw: 0, pitch: 0, held: 0, alive: true };
  socket.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > 4 * 1024 * 1024) { socket.destroy(); return; }
    parseFrames(c);
  });
  socket.on('close', () => dropClient(c));
  socket.on('error', () => dropClient(c));
});

function parseFrames(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1];
    const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 2 * 1024 * 1024) { c.socket.destroy(); return; }
    const total = off + (masked ? 4 : 0) + len;
    if (c.buf.length < total) return;
    let payload = Buffer.from(c.buf.subarray(off + (masked ? 4 : 0), total));
    if (masked) {
      const mask = c.buf.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    c.buf = c.buf.subarray(total);
    if (op === 8) { try { c.socket.write(frame(8, Buffer.alloc(0))); } catch (e) { /* ignore */ } c.socket.end(); return; }
    if (op === 9) { try { c.socket.write(frame(10, payload)); } catch (e) { /* ignore */ } continue; }
    if (op === 10) continue;
    if (op === 1 || op === 2 || op === 0) {
      c.frag.push(payload);
      if (fin) {
        const msg = Buffer.concat(c.frag).toString('utf8');
        c.frag = [];
        let obj = null;
        try { obj = JSON.parse(msg); } catch (e) { /* ignore */ }
        if (obj && typeof obj === 'object') handle(c, obj);
      }
    }
  }
}

function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

function handle(c, m) {
  if (m.t === 'join' && !c.ready) {
    c.id = nextId++;
    c.name = String(m.name || 'Gracz').replace(/[^\w\u00C0-\u017F \-]/g, '').slice(0, 16) || 'Gracz';
    c.ready = true;
    const blocks = [];
    for (const k in world.blocks) { const p = k.split(','); blocks.push([+p[0], +p[1], +p[2], world.blocks[k]]); }
    const players = [];
    for (const o of clients.values()) if (o !== c && o.ready) players.push({ id: o.id, name: o.name, x: o.x, y: o.y, z: o.z });
    clients.set(c.id, c);
    send(c, { t: 'init', id: c.id, seed: world.seed, time: currentTime(), blocks, players });
    broadcast({ t: 'join', id: c.id, name: c.name }, c);
    console.log('[+] ' + c.name + ' (#' + c.id + ') dołączył. Graczy: ' + clients.size);
    broadcast({ t: 'chat', name: 'Serwer', m: c.name + ' dołączył do gry' }, c);
    assignMobHost();
    return;
  }
  if (!c.ready) return;
  switch (m.t) {
    case 'pos':
      c.x = num(m.x, c.x); c.y = num(m.y, c.y); c.z = num(m.z, c.z); c.yaw = num(m.yaw, 0); c.pitch = num(m.pitch, 0); c.held = m.held | 0;
      broadcast({ t: 'pos', id: c.id, x: c.x, y: c.y, z: c.z, yaw: c.yaw, pitch: c.pitch, held: c.held, sw: m.sw ? 1 : 0 }, c);
      break;
    case 'block': {
      const x = Math.floor(num(m.x, NaN)), y = Math.floor(num(m.y, NaN)), z = Math.floor(num(m.z, NaN)), id = m.id | 0;
      if (!isFinite(x) || !isFinite(y) || !isFinite(z) || y < 0 || y > 95 || id < 0 || id > 255) return;
      world.blocks[x + ',' + y + ',' + z] = id;
      dirty = true;
      broadcast({ t: 'block', x, y, z, id }, c);
      break;
    }
    case 'chat': {
      const text = String(m.m || '').slice(0, 200);
      if (!text) return;
      console.log('<' + c.name + '> ' + text);
      broadcast({ t: 'chat', name: c.name, m: text });
      break;
    }
    case 'hit': {
      const target = clients.get(m.id | 0);
      if (target && target !== c) send(target, { t: 'hit', dmg: Math.max(0, Math.min(20, num(m.dmg, 1))), from: c.name, kx: num(m.kx, 0), kz: num(m.kz, 0) });
      break;
    }
    /* ---- moby: host-symulacja, serwer tylko przekazuje ---- */
    case 'mobs': {
      if (c.id !== mobHostId) return; // tylko host może publikować stan mobów
      lastMobs = Array.isArray(m.list) ? m.list.slice(0, 500) : [];
      broadcast({ t: 'mobs', list: lastMobs }, c);
      break;
    }
    case 'mobHit': {
      const host = mobHostId !== null ? clients.get(mobHostId) : null;
      if (!host) return;
      send(host, {
        t: 'mobHit',
        id: m.id | 0,
        dmg: Math.max(0, Math.min(1000, num(m.dmg, 1))),
        kx: num(m.kx, 0), kz: num(m.kz, 0),
        from: c.id
      });
      break;
    }
    case 'mobEvent': {
      if (c.id !== mobHostId) return; // np. śmierć moba, efekt – tylko host decyduje
      broadcast({ t: 'mobEvent', ev: String(m.ev || ''), id: m.id | 0, x: num(m.x, 0), y: num(m.y, 0), z: num(m.z, 0) }, c);
      break;
    }
  }
}

function dropClient(c) {
  if (!c.alive) return;
  c.alive = false;
  if (c.ready && clients.delete(c.id)) {
    broadcast({ t: 'leave', id: c.id });
    broadcast({ t: 'chat', name: 'Serwer', m: c.name + ' opuścił grę' });
    console.log('[-] ' + c.name + ' (#' + c.id + ') rozłączony. Graczy: ' + clients.size);
    if (c.id === mobHostId) assignMobHost(c);
  }
  try { c.socket.destroy(); } catch (e) { /* ignore */ }
}

setInterval(() => broadcast({ t: 'time', time: currentTime() }), 10000);
setInterval(() => {
  for (const c of clients.values()) { try { c.socket.write(frame(9, Buffer.alloc(0))); } catch (e) { /* ignore */ } }
}, 25000);

function shutdown() { dirty = true; try { fs.writeFileSync(SAVE_FILE, JSON.stringify(world)); } catch (e) { /* ignore */ } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log('===============================================');
  console.log(' PocketMC działa!  Otwórz: http://localhost:' + PORT);
  console.log(' Multiplayer: w grze wybierz "Wielu graczy" i wpisz adres tego komputera:' + PORT);
  console.log('===============================================');
});