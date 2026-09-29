const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http);
const fs = require('fs');
const path = require('path');

app.use(express.static('public'));

const WORLD_FILE = path.join(__dirname, 'world.json');
const WORLD_SIZE = 48;

// ============ GENERACJA / WCZYTYWANIE ŚWIATA ============
function simpleNoise(x, z) {
  return Math.floor(
    3 +
    Math.sin(x * 0.15) * 1 +
    Math.cos(z * 0.15) * 1 +
    Math.sin((x + z) * 0.07) * 0.5
  );
}

function simpleNoise(x, z) {
  return Math.floor(
    3 +
    Math.sin(x * 0.15) * 1 +
    Math.cos(z * 0.15) * 1 +
    Math.sin((x + z) * 0.07) * 0.5
  );
}

// Prosty deterministyczny generator "losowości" na podstawie współrzędnych
// (żeby przy tym samym x,z zawsze wychodziła ta sama wartość)
function pseudoRandom(x, z, seed) {
  const val = Math.sin(x * 12.9898 + z * 78.233 + seed * 37.719) * 43758.5453;
  return val - Math.floor(val);
}

const WATER_LEVEL = 2; // poziom "morza" - poniżej tej wysokości teren to woda

function generateNewWorld() {
  const world = {};

  for (let x = 0; x < WORLD_SIZE; x++) {
    for (let z = 0; z < WORLD_SIZE; z++) {
      const height = simpleNoise(x, z);

      for (let y = 0; y <= Math.max(height, WATER_LEVEL); y++) {
        let type;

        if (y > height) {
          // Powyżej terenu, ale poniżej poziomu wody = woda
          type = 'water';
        } else if (y === height) {
          // Wierzchnia warstwa
          if (height <= WATER_LEVEL + 1) {
            type = 'sand'; // plaża przy wodzie
          } else {
            type = 'grass';
          }
        } else if (y > height - 3) {
          type = (height <= WATER_LEVEL + 1) ? 'sand' : 'dirt';
        } else {
          // Kamień, czasem z rudą
          const rnd = pseudoRandom(x, z, y);
          if (rnd < 0.02) {
            type = 'gold_ore';
          } else if (rnd < 0.06) {
            type = 'coal_ore';
          } else {
            type = 'stone';
          }
        }

        world[`${x},${y},${z}`] = type;
      }

      // Losowe drzewa na trawie (nie za blisko wody)
      if (height > WATER_LEVEL + 1) {
        const treeChance = pseudoRandom(x, z, 999);
        if (treeChance < 0.03) { // 3% szans na drzewo w danym miejscu
          generateTree(world, x, height + 1, z);
        }
      }
    }
  }
  return world;
}

function generateTree(world, x, y, z) {
  // Pień (4 bloki wysokości)
  const trunkHeight = 4;
  for (let i = 0; i < trunkHeight; i++) {
    world[`${x},${y + i},${z}`] = 'wood';
  }

  // Korona z liści (prosty kształt kulisty)
  const leafY = y + trunkHeight;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const dist = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
        if (dist <= 3 && !(dx === 0 && dz === 0 && dy <= 0)) {
          const key = `${x + dx},${leafY + dy},${z + dz}`;
          if (!world[key]) { // nie nadpisuj pnia
            world[key] = 'leaves';
          }
        }
      }
    }
  }
}

let worldData = {};

// Wczytaj zapisany świat, jeśli istnieje - w przeciwnym razie wygeneruj nowy
if (fs.existsSync(WORLD_FILE)) {
  console.log('Wczytuję zapisany świat...');
  worldData = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf-8'));
} else {
  console.log('Generuję nowy świat...');
  worldData = generateNewWorld();
  saveWorld();
}

function saveWorld() {
  fs.writeFileSync(WORLD_FILE, JSON.stringify(worldData));
}

// Zapisuj świat co 30 sekund (jeśli były zmiany) oraz przy zamknięciu serwera
let worldChanged = false;
setInterval(() => {
  if (worldChanged) {
    saveWorld();
    worldChanged = false;
    console.log('Świat zapisany.');
  }
}, 30000);

process.on('SIGINT', () => {
  console.log('Zapisuję świat przed zamknięciem...');
  saveWorld();
  process.exit();
});

// ============ GRACZE ============
const players = {};

io.on('connection', (socket) => {
  console.log(`Gracz połączony: ${socket.id}`);

  players[socket.id] = {
    x: 24, y: 20, z: 24,
    yaw: 0, pitch: 0,
    id: socket.id,
    name: 'Gracz'
  };

  // Wyślij nowemu graczowi CAŁY stan świata + listę graczy
  socket.emit('worldData', worldData);
  socket.emit('currentPlayers', players);
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('setName', (name) => {
    if (players[socket.id]) {
      players[socket.id].name = name.substring(0, 15);
      io.emit('playerNameChanged', { id: socket.id, name: players[socket.id].name });
    }
  });

  socket.on('playerMove', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].z = data.z;
      players[socket.id].yaw = data.yaw;
      players[socket.id].pitch = data.pitch;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // Stawianie/niszczenie bloków - TERAZ AKTUALIZUJE SERWEROWY STAN ŚWIATA
  socket.on('blockPlaced', (data) => {
    const key = `${data.x},${data.y},${data.z}`;
    worldData[key] = data.type;
    worldChanged = true;
    socket.broadcast.emit('blockPlaced', data);
  });

  socket.on('blockRemoved', (data) => {
    const key = `${data.x},${data.y},${data.z}`;
    delete worldData[key];
    worldChanged = true;
    socket.broadcast.emit('blockRemoved', data);
  });

  socket.on('chatMessage', (msg) => {
    const playerName = players[socket.id] ? players[socket.id].name : 'Nieznajomy';
    io.emit('chatMessage', {
      name: playerName,
      message: msg.substring(0, 100),
      id: socket.id
    });
  });

  socket.on('disconnect', () => {
    console.log(`Gracz rozłączony: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Serwer multiplayer działa na porcie ${PORT}`);
});