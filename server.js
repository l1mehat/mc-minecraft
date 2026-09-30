const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http);
const fs = require('fs');
const path = require('path');

app.use(express.static('public'));

// ================= CONFIG (finite + duża mapa) =================
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '16', 10);
const WORLD_SIZE = parseInt(process.env.WORLD_SIZE || '1024', 10);
const WORLD_HEIGHT = parseInt(process.env.WORLD_HEIGHT || '64', 10);
const WATER_LEVEL = parseInt(process.env.WATER_LEVEL || '12', 10);
const TREE_PROB = parseFloat(process.env.TREE_PROB || '0.03');
const MAX_BUILD_DISTANCE = parseFloat(process.env.MAX_BUILD_DISTANCE || '8.0');

const chunkKey = (cx, cz) => `${cx},${cz}`;
const maxChunk = Math.floor(WORLD_SIZE / CHUNK_SIZE);

// ================= DATA PATHS =================
const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  (fs.existsSync('/data') ? '/data' : __dirname);

const META_FILE = path.join(DATA_DIR, 'world_meta.json');
const EDITS_FILE = path.join(DATA_DIR, 'world_edits.json');

// ================= DETERMINISTIC WORLD (base) =================
function simpleNoise(x, z, seed, worldSize) {
  const nx = x - worldSize / 2;
  const nz = z - worldSize / 2;
  const s = seed * 0.0001;

  const h =
    10 +
    Math.sin((nx + s) * 0.04) * 8 +
    Math.cos((nz - s) * 0.04) * 8 +
    Math.sin((nx + nz + s) * 0.02) * 4;

  return Math.floor(h);
}

function pseudoRandom(x, z, seed) {
  const v = Math.sin(x * 12.9898 + z * 78.233 + seed * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

function clampInt(n, a, b) {
  return Math.max(a, Math.min(b, n | 0));
}

function getColumnHeight(x, z, seed) {
  const h = simpleNoise(x, z, seed, WORLD_SIZE);
  return clampInt(h, 1, WORLD_HEIGHT - 1);
}

// Caves + clustered ores helpers
function signal3D(x, y, z, seed, f, yScale) {
  const a = Math.sin((x + seed * 0.13) * f) * Math.cos((z - seed * 0.07) * f);
  const b = Math.sin((y + seed * 0.09) * (f * yScale)) * 0.85;
  return Math.abs(a + b) / 1.85;
}

function shouldCarveCave(x, y, z, seed) {
  if (y < 6 || y > WORLD_HEIGHT - 7) return false;

  const d = y / WORLD_HEIGHT; // 0..1
  const depthBias = 1 - Math.min(1, Math.abs(d - 0.32) / 0.32);
  const threshold = 0.60 - depthBias * 0.10;

  const c = signal3D(x, y, z, seed + 777, 0.09, 0.72);
  return c > threshold;
}

function clusteredOreInStone(x, y, z, seed) {
  // gold niżej
  if (y >= 6 && y <= 26) {
    const n = signal3D(x, y, z, seed + 202, 0.17, 0.78);
    const gate = pseudoRandom(x + y * 0.07, z - y * 0.03, seed + 999);
    if (n > 0.60 && gate < 0.18) return 'gold_ore';
  }

  // coal szerzej
  if (y >= 5 && y <= 45) {
    const n = signal3D(x, y, z, seed + 101, 0.15, 0.78);
    const gate = pseudoRandom(x + y * 0.05, z - y * 0.02, seed + 333);
    if (n > 0.62 && gate < 0.26) return 'coal_ore';
  }

  return 'stone';
}

function getBaseBlockType(x, y, z, seed) {
  if (x < 0 || x >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) return null;
  if (y < 0 || y >= WORLD_HEIGHT) return null;

  const h = getColumnHeight(x, z, seed);

  // --- AIR ABOVE TERRAIN/WATER ---
  const maxY = Math.max(h, WATER_LEVEL);
  let type = null;

  if (y <= maxY) {
    if (y > h) type = 'water';
    else if (y === h) type = h <= WATER_LEVEL + 1 ? 'sand' : 'grass';
    else if (y > h - 3) type = h <= WATER_LEVEL + 1 ? 'sand' : 'dirt';
    else {
      // deep => stone/caves + clustered ores
      if (shouldCarveCave(x, y, z, seed)) {
        type = null; // jaskinia
      } else {
        type = clusteredOreInStone(x, y, z, seed);
      }
    }
  }

  // --- TREES (override even above caves/stone) ---
  const baseTreeRadius = 2;

  for (let dx0 = -baseTreeRadius; dx0 <= baseTreeRadius; dx0++) {
    for (let dz0 = -baseTreeRadius; dz0 <= baseTreeRadius; dz0++) {
      const tx = x + dx0;
      const tz = z + dz0;

      if (tx < 0 || tx >= WORLD_SIZE || tz < 0 || tz >= WORLD_SIZE) continue;

      const th = getColumnHeight(tx, tz, seed);
      if (!(th > WATER_LEVEL + 1)) continue;

      const hasTree = pseudoRandom(tx, tz, 999 + seed * 13) < TREE_PROB;
      if (!hasTree) continue;

      const trunkHeight = 4;
      const trunkTopY = th + trunkHeight; // th+4
      const treeOriginY = th + 1; // wood start at th+1

      // trunk wood
      if (x === tx && z === tz && y >= treeOriginY && y < treeOriginY + trunkHeight) {
        return 'wood';
      }

      // leaves volume
      const leafY = trunkTopY + 1; // th+5
      const dx = x - tx;
      const dz = z - tz;
      const dy = y - leafY;

      if (dx < -2 || dx > 2 || dz < -2 || dz > 2) continue;
      if (dy < -1 || dy > 1) continue;

      const dist = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
      if (dist <= 3 && !(dx === 0 && dz === 0 && dy <= 0)) {
        return 'leaves';
      }
    }
  }

  return type;
}

// ================= PERSISTENCE (edits only) =================
let worldSeed = 0;
let editsByChunk = {};

function loadMetaAndEdits() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // meta seed
  try {
    if (fs.existsSync(META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
      worldSeed = Number(meta.seed) || 0;
    } else {
      worldSeed = Math.floor(Math.random() * 1e9);
      fs.writeFileSync(META_FILE, JSON.stringify({ seed: worldSeed }), 'utf-8');
    }
  } catch (e) {
    console.error('Failed to load/save meta:', e);
    worldSeed = Math.floor(Math.random() * 1e9);
    try { fs.writeFileSync(META_FILE, JSON.stringify({ seed: worldSeed }), 'utf-8'); } catch {}
  }

  // edits
  try {
    if (fs.existsSync(EDITS_FILE)) {
      editsByChunk = JSON.parse(fs.readFileSync(EDITS_FILE, 'utf-8')) || {};
    } else {
      editsByChunk = {};
    }
  } catch (e) {
    console.error('Failed to load edits:', e);
    editsByChunk = {};
  }
}

loadMetaAndEdits();

let worldChanged = false;

function saveEditsAtomic() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = EDITS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(editsByChunk));
    fs.renameSync(tmp, EDITS_FILE);
    worldChanged = false;
  } catch (e) {
    console.error('Failed to save edits:', e);
  }
}

setInterval(() => {
  if (worldChanged) {
    saveEditsAtomic();
    console.log('Edits saved.');
  }
}, 15000);

function shutdown(signal) {
  console.log(`${signal} received, saving edits...`);
  saveEditsAtomic();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ================= PLAYERS =================
const players = {};

function isInt(n) {
  return Number.isInteger(n) && Math.abs(n) < 1e9;
}

function dist(a, b, c, px, py, pz) {
  const dx = a - px, dy = b - py, dz = c - pz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ================= Effective block = base + edits =================
function getEffectiveBlockType(x, y, z) {
  if (x < 0 || x >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) return null;
  if (y < 0 || y >= WORLD_HEIGHT) return null;

  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const cKey = chunkKey(cx, cz);
  const chunkEdits = editsByChunk[cKey];

  const coordKey = `${x},${y},${z}`;
  if (chunkEdits && Object.prototype.hasOwnProperty.call(chunkEdits, coordKey)) {
    return chunkEdits[coordKey]; // string albo null
  }

  return getBaseBlockType(x, y, z, worldSeed);
}

function setEffectiveBlockType(x, y, z, newTypeOrNull) {
  if (x < 0 || x >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) return false;
  if (y < 0 || y >= WORLD_HEIGHT) return false;

  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const cKey = chunkKey(cx, cz);

  editsByChunk[cKey] ||= {};
  const coordKey = `${x},${y},${z}`;

  const baseType = getBaseBlockType(x, y, z, worldSeed);

  // usuń override, jeśli trafiasz w to co i tak już jest w bazie
  if (baseType === newTypeOrNull) {
    if (editsByChunk[cKey] && editsByChunk[cKey][coordKey] !== undefined) {
      delete editsByChunk[cKey][coordKey];
      worldChanged = true;
      if (Object.keys(editsByChunk[cKey]).length === 0) delete editsByChunk[cKey];
      return true;
    }
    return false;
  }

  editsByChunk[cKey][coordKey] = newTypeOrNull; // string albo null
  worldChanged = true;
  return true;
}

// ================= SOCKET.IO =================
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  const SPAWN_X = Math.floor(WORLD_SIZE / 2);
  const SPAWN_Z = Math.floor(WORLD_SIZE / 2);
  const spawnH = getColumnHeight(SPAWN_X, SPAWN_Z, worldSeed);
  const spawnY = Math.min(WORLD_HEIGHT - 2, spawnH + 3);

  players[socket.id] = {
    id: socket.id,
    x: SPAWN_X,
    y: spawnY,
    z: SPAWN_Z,
    yaw: 0,
    pitch: 0,
    name: 'Player',
    gameMode: 'creative'
  };

  socket.emit('worldMeta', {
    seed: worldSeed,
    chunkSize: CHUNK_SIZE,
    worldSize: WORLD_SIZE,
    worldHeight: WORLD_HEIGHT,
    waterLevel: WATER_LEVEL,
    treeProb: TREE_PROB
  });

  socket.emit('currentPlayers', players);
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('setName', (name) => {
    if (!players[socket.id]) return;
    players[socket.id].name = String(name).substring(0, 15);
    io.emit('playerNameChanged', {
      id: socket.id,
      name: players[socket.id].name
    });
  });

  socket.on('setGameMode', (mode) => {
    if (players[socket.id] && (mode === 'creative' || mode === 'survival')) {
      players[socket.id].gameMode = mode;
    }
  });

  socket.on('playerMove', (data) => {
    const p = players[socket.id];
    if (!p || !data) return;

    p.x = Number(data.x) || 0;
    p.y = Number(data.y) || 0;
    p.z = Number(data.z) || 0;
    p.yaw = Number(data.yaw) || 0;
    p.pitch = Number(data.pitch) || 0;

    socket.broadcast.emit('playerMoved', p);
  });

  // chunk streaming
  socket.on('requestChunk', (d) => {
    if (!d) return;
    const cx = Number(d.cx);
    const cz = Number(d.cz);
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;

    if (cx < 0 || cz < 0 || cx >= maxChunk || cz >= maxChunk) return;

    const cKey = chunkKey(cx, cz);
    const edits = editsByChunk[cKey] || {};
    socket.emit('chunkData', { cx, cz, edits });
  });

  // block updates
  socket.on('blockPlaced', (data) => {
    if (!data) return;
    const { x, y, z, type } = data;
    if (!isInt(x) || !isInt(y) || !isInt(z)) return;
    if (typeof type !== 'string' || type.length > 32) return;

    const p = players[socket.id];
    if (!p) return;

    if (dist(x, y, z, p.x, p.y, p.z) > MAX_BUILD_DISTANCE) return;

    const changed = setEffectiveBlockType(x, y, z, type);
    if (!changed) return;

    socket.broadcast.emit('blockUpdate', { x, y, z, type });
  });

  socket.on('blockRemoved', (data) => {
    if (!data) return;
    const { x, y, z } = data;
    if (!isInt(x) || !isInt(y) || !isInt(z)) return;

    const p = players[socket.id];
    if (!p) return;

    if (dist(x, y, z, p.x, p.y, p.z) > MAX_BUILD_DISTANCE) return;

    const changed = setEffectiveBlockType(x, y, z, null);
    if (!changed) return;

    socket.broadcast.emit('blockUpdate', { x, y, z, type: null });
  });

  // chat
  socket.on('chatMessage', (msg) => {
    const playerName = players[socket.id] ? players[socket.id].name : 'Unknown';

    const clean = String(msg)
      .substring(0, 100)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const cleanName = String(playerName)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    io.emit('chatMessage', { name: cleanName, message: clean, id: socket.id });
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Chunked multiplayer server on port ${PORT}`);
  console.log(`WORLD_SIZE=${WORLD_SIZE}, WORLD_HEIGHT=${WORLD_HEIGHT}, CHUNK_SIZE=${CHUNK_SIZE}, seed=${worldSeed}`);
});