const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http);
const fs = require('fs');
const path = require('path');
 
app.use(express.static('public'));
 
// ============ ŚCIEŻKA ZAPISU ============
// Railway Volume: ustaw mount path na /data (Railway podaje go też w RAILWAY_VOLUME_MOUNT_PATH).
// Bez Volume zapis ląduje w katalogu aplikacji i znika po redeployu.
const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  (fs.existsSync('/data') ? '/data' : __dirname);
const WORLD_FILE = path.join(DATA_DIR, 'world.json');
const WORLD_SIZE = 48;
const WATER_LEVEL = 2;
 
console.log('World file:', WORLD_FILE);
 
// ============ GENERACJA ŚWIATA ============
function simpleNoise(x, z) {
  return Math.floor(
    3 +
    Math.sin(x * 0.15) * 1.2 +
    Math.cos(z * 0.15) * 1.2 +
    Math.sin((x + z) * 0.07) * 0.6
  );
}
 
function pseudoRandom(x, z, seed) {
  const val = Math.sin(x * 12.9898 + z * 78.233 + seed * 37.719) * 43758.5453;
  return val - Math.floor(val);
}
 
function generateNewWorld() {
  const world = {};
  for (let x = 0; x < WORLD_SIZE; x++) {
    for (let z = 0; z < WORLD_SIZE; z++) {
      const height = simpleNoise(x, z);
      for (let y = 0; y <= Math.max(height, WATER_LEVEL); y++) {
        let type;
        if (y > height) {
          type = 'water';
        } else if (y === height) {
          type = height <= WATER_LEVEL + 1 ? 'sand' : 'grass';
        } else if (y > height - 3) {
          type = height <= WATER_LEVEL + 1 ? 'sand' : 'dirt';
        } else {
          const rnd = pseudoRandom(x, z, y);
          if (rnd < 0.02) type = 'gold_ore';
          else if (rnd < 0.06) type = 'coal_ore';
          else type = 'stone';
        }
        world[`${x},${y},${z}`] = type;
      }
      if (height > WATER_LEVEL + 1 && pseudoRandom(x, z, 999) < 0.03) {
        generateTree(world, x, height + 1, z);
      }
    }
  }
  return world;
}
 
function generateTree(world, x, y, z) {
  const trunkHeight = 4;
  for (let i = 0; i < trunkHeight; i++) {
    world[`${x},${y + i},${z}`] = 'wood';
  }
  const leafY = y + trunkHeight;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const dist = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
        if (dist <= 3 && !(dx === 0 && dz === 0 && dy <= 0)) {
          const k = `${x + dx},${leafY + dy},${z + dz}`;
          if (!world[k]) world[k] = 'leaves';
        }
      }
    }
  }
}
 
// ============ WCZYTYWANIE / ZAPISYWANIE ŚWIATA ============
let worldData = {};
let worldChanged = false;
 
function saveWorld() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // zapis do pliku tymczasowego + rename, żeby awaria w trakcie nie uszkodziła świata
    const tmp = WORLD_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(worldData));
    fs.renameSync(tmp, WORLD_FILE);
    worldChanged = false;
  } catch (e) {
    console.error('Failed to save world:', e);
  }
}
 
if (fs.existsSync(WORLD_FILE)) {
  console.log('Loading saved world...');
  try {
    worldData = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf-8'));
  } catch (e) {
    console.log('World file corrupted, generating new world...');
    worldData = generateNewWorld();
    saveWorld();
  }
} else {
  console.log('Generating new world...');
  worldData = generateNewWorld();
  saveWorld();
}
 
setInterval(() => {
  if (worldChanged) {
    saveWorld();
    console.log('World saved.');
  }
}, 30000);
 
// Railway wysyła SIGTERM przy redeployu, SIGINT to Ctrl+C lokalnie
function shutdown(signal) {
  console.log(`${signal} received, saving world...`);
  saveWorld();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
 
// ============ GRACZE ============
const players = {};
 
function isInt(n) {
  return Number.isInteger(n) && Math.abs(n) < 100000;
}
 
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
 
  players[socket.id] = {
    x: WORLD_SIZE / 2,
    y: 20,
    z: WORLD_SIZE / 2,
    yaw: 0,
    pitch: 0,
    id: socket.id,
    name: 'Player',
    gameMode: 'creative'
  };
 
  socket.emit('worldData', worldData);
  socket.emit('currentPlayers', players);
  socket.broadcast.emit('newPlayer', players[socket.id]);
 
  socket.on('setName', (name) => {
    if (players[socket.id]) {
      players[socket.id].name = String(name).substring(0, 15);
      io.emit('playerNameChanged', {
        id: socket.id,
        name: players[socket.id].name
      });
    }
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
 
  socket.on('blockPlaced', (data) => {
    if (!data || !isInt(data.x) || !isInt(data.y) || !isInt(data.z)) return;
    if (typeof data.type !== 'string' || data.type.length > 32) return;
    worldData[`${data.x},${data.y},${data.z}`] = data.type;
    worldChanged = true;
    socket.broadcast.emit('blockPlaced', data);
  });
 
  socket.on('blockRemoved', (data) => {
    if (!data || !isInt(data.x) || !isInt(data.y) || !isInt(data.z)) return;
    delete worldData[`${data.x},${data.y},${data.z}`];
    worldChanged = true;
    socket.broadcast.emit('blockRemoved', data);
  });
 
  socket.on('chatMessage', (msg) => {
    const playerName = players[socket.id] ? players[socket.id].name : 'Unknown';
    // escape HTML, bo klient wstawia wiadomości przez innerHTML
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
  console.log(`Multiplayer server running on port ${PORT}`);
});