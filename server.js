import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSONFilePreset } from 'lowdb/node';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// --- LOWDB SETUP ---
const defaultData = { users: {} };
const db = await JSONFilePreset(join(__dirname, 'db.json'), defaultData);

// --- ADMIN PANEL SETTINGS ---
const ADMIN_SECRET = "changeme"; // Must match admin panel

// --- In-memory game state ---
let players = {};
let calledNumbers = new Set();
let lockedSeeds = [];
let allCallPool = [];
let callInterval = null;
let winner = null;
let balanceMap = {};
let currentCards = {};
let playerUsernames = {};

function shuffle(array) {
  let m = array.length, t, i;
  while (m) {
    i = Math.floor(Math.random() * m--);
    t = array[m]; array[m] = array[i]; array[i] = t;
  }
  return array;
}

function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

function generateCard(seed) {
  const rand = mulberry32(seed);
  const ranges = [[1,15], [16,30], [31,45], [46,60], [61,75]];
  const card = [];
  for (let col = 0; col < 5; col++) {
    const [min, max] = ranges[col];
    const nums = new Set();
    while (nums.size < 5) {
      const n = Math.floor(rand() * (max - min + 1)) + min;
      nums.add(n);
    }
    card.push([...nums]);
  }
  card[2][2] = 'FREE';
  return card;
}

function checkBingo(card, markedSet) {
  // Rows
  for (let r = 0; r < 5; r++) {
    let row = true;
    for (let c = 0; c < 5; c++) {
      if (card[c][r] !== 'FREE' && !markedSet.has(card[c][r])) row = false;
    }
    if (row) return true;
  }
  // Columns
  for (let c = 0; c < 5; c++) {
    let col = true;
    for (let r = 0; r < 5; r++) {
      if (card[c][r] !== 'FREE' && !markedSet.has(card[c][r])) col = false;
    }
    if (col) return true;
  }
  // Diagonals
  let diag1 = true, diag2 = true;
  for (let i = 0; i < 5; i++) {
    if (card[i][i] !== 'FREE' && !markedSet.has(card[i][i])) diag1 = false;
    if (card[i][4 - i] !== 'FREE' && !markedSet.has(card[i][4 - i])) diag2 = false;
  }
  return diag1 || diag2;
}

// --- Serve static files from /public ---
app.use(express.static(join(__dirname, 'public')));

// --- ADMIN API MIDDLEWARE ---
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth === "Bearer " + ADMIN_SECRET) {
    return next();
  }
  res.status(403).json({ error: "Forbidden" });
}

// --- ADMIN API ENDPOINTS ---

// List all users and balances
app.get('/admin/list-users', requireAdmin, async (req, res) => {
  await db.write();
  res.json({ users: db.data.users });
});

// Get a user's balance by Telegram username
app.get('/admin/get-balance', requireAdmin, async (req, res) => {
  await db.write();
  const username = req.query.username;
  if (!username || !db.data.users[username]) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ balance: db.data.users[username].balance });
});

// Update a user's balance by Telegram username
app.post('/admin/update-balance', express.json(), requireAdmin, async (req, res) => {
  const { username, amount } = req.body;
  if (!username || typeof amount !== "number") {
    return res.status(400).json({ error: "Invalid username or amount" });
  }
  if (!db.data.users[username]) {
    db.data.users[username] = { balance: amount };
  } else {
    db.data.users[username].balance = amount;
  }
  await db.write();

  // Also update the live balance if the user is connected
  for (const [socketId, info] of Object.entries(players)) {
    if (info.username === username && balanceMap[socketId] !== undefined) {
      balanceMap[socketId] = amount;
      io.to(socketId).emit('balanceUpdate', amount);
    }
  }
  res.json({ success: true });
});

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
  socket.on('register', async ({ username, seed }) => {
    playerUsernames[socket.id] = username;
    players[socket.id] = { username, seed };
    lockedSeeds.push(seed);
    currentCards[socket.id] = generateCard(seed);

    // Load or create user in db
    if (!db.data.users[username]) {
      db.data.users[username] = { balance: 100 };
      await db.write();
    }
    balanceMap[socket.id] = db.data.users[username].balance;
    socket.emit('balanceUpdate', balanceMap[socket.id]);
    io.emit('playerCount', Object.keys(players).length);

    // If first player, start the game
    if (Object.keys(players).length === 1 && !callInterval) {
      startCallingNumbers();
      io.emit('gameStarted', { playerCount: Object.keys(players).length });
    }
  });

  // Sync balance on update
  socket.on('balanceUpdate', async (newBalance) => {
    if (playerUsernames[socket.id]) {
      db.data.users[playerUsernames[socket.id]].balance = newBalance;
      await db.write();
    }
  });

  socket.emit('init', {
    calledNumbers: Array.from(calledNumbers),
    balance: balanceMap[socket.id] || 100,
    lockedSeeds
  });

  socket.on('checkBingo', async (markedArr) => {
    if (!currentCards[socket.id] || winner) return;
    const card = currentCards[socket.id];
    const markedSet = new Set(markedArr.map(Number));
    let valid = true;
    for (let n of markedSet) {
      if (!calledNumbers.has(n) && n !== 'FREE') valid = false;
    }
    if (!valid) {
      socket.emit('blocked', "Invalid Bingo claim (unmarked numbers)");
      return;
    }
    if (checkBingo(card, markedSet)) {
      winner = { username: playerUsernames[socket.id], card };
      db.data.users[winner.username].balance += 25;
      await db.write();
      balanceMap[socket.id] = db.data.users[winner.username].balance;
      socket.emit('balanceUpdate', balanceMap[socket.id]);
      io.emit('winner', winner);

      // STOP number calling for everyone
      if (callInterval) {
        clearInterval(callInterval);
        callInterval = null;
      }
      io.emit('stopCalling');
      setTimeout(resetGame, 15000);
    } else {
      socket.emit('blocked', "No Bingo found!");
    }
  });

  socket.on('playAgain', () => {
    socket.emit('reset');
  });

  socket.on('endGame', () => {
    delete players[socket.id];
    delete currentCards[socket.id];
    delete playerUsernames[socket.id];
    io.emit('playerCount', Object.keys(players).length);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    delete currentCards[socket.id];
    delete playerUsernames[socket.id];
    io.emit('playerCount', Object.keys(players).length);
  });
});

function startCallingNumbers() {
  allCallPool = shuffle(Array.from({ length: 75 }, (_, i) => i + 1));
  callInterval = setInterval(() => {
    if (allCallPool.length === 0 || winner) {
      if (callInterval) {
        clearInterval(callInterval);
        callInterval = null;
      }
      return;
    }
    const number = allCallPool.shift();
    calledNumbers.add(number);
    io.emit('numberCalled', number);
  }, 5000);
}

function resetGame() {
  calledNumbers = new Set();
  lockedSeeds = [];
  winner = null;
  allCallPool = [];
  for (let id in players) {
    if (players[id].seed) lockedSeeds.push(players[id].seed);
  }
  io.emit('reset');
}

server.listen(PORT, () => {
  console.log(`Bingo server running on http://localhost:${PORT}`);
});
