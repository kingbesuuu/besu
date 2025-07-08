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
const ENTRY_FEE = 10;

// --- LOWDB SETUP ---
const defaultData = { users: {} };
const db = await JSONFilePreset(join(__dirname, 'db.json'), defaultData);

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

let countdown = 60;
let countdownInterval = null;
let gameStarted = false;

// --- Helper functions ---
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
  };
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
  for (let r = 0; r < 5; r++) {
    if (card.every((col, c) => col[r] === 'FREE' || markedSet.has(col[r]))) return true;
  }
  for (let c = 0; c < 5; c++) {
    if (card[c].every((val, r) => val === 'FREE' || markedSet.has(val))) return true;
  }
  if ([0, 1, 2, 3, 4].every(i => card[i][i] === 'FREE' || markedSet.has(card[i][i]))) return true;
  if ([0, 1, 2, 3, 4].every(i => card[i][4 - i] === 'FREE' || markedSet.has(card[i][4 - i]))) return true;
  return false;
}

app.use(express.static(join(__dirname, 'public')));

// --- Game Management ---
function startCountdown() {
  countdown = 60;
  io.emit('countdown', countdown);
  countdownInterval = setInterval(() => {
    countdown--;
    io.emit('countdown', countdown);
    if (countdown <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      startCallingNumbers();
      io.emit('gameStarted', { playerCount: Object.keys(players).length });
      gameStarted = true;
    }
  }, 1000);
}

function startCallingNumbers() {
  allCallPool = shuffle(Array.from({ length: 75 }, (_, i) => i + 1));
  callInterval = setInterval(() => {
    if (allCallPool.length === 0 || winner) {
      clearInterval(callInterval);
      callInterval = null;
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
  gameStarted = false;

  for (let id in players) {
    if (players[id].seed) lockedSeeds.push(players[id].seed);
  }

  io.emit('reset');
}

io.on('connection', (socket) => {
  socket.on('register', async ({ username, seed }) => {
    console.log("Register called:", username, seed);

    if (!/^[a-zA-Z0-9_]{5,32}$/.test(username)) {
      socket.emit('blocked', "Only real Telegram usernames are allowed.");
      return;
    }

    if (lockedSeeds.includes(seed)) {
      socket.emit('blocked', "Card already picked by another player.");
      return;
    }

    playerUsernames[socket.id] = username;
    players[socket.id] = { username, seed };
    lockedSeeds.push(seed);
    currentCards[socket.id] = generateCard(seed);

    // ✅ Ensure new users start with 10 balance
    if (!db.data.users[username]) {
      db.data.users[username] = { balance: 10 };
      console.log("🎉 New user initialized:", username);
    } else if (typeof db.data.users[username].balance !== 'number') {
      db.data.users[username].balance = 10;
      console.log("🛠️ Fixed invalid balance for:", username);
    }

    await db.write();

    if (db.data.users[username].balance < ENTRY_FEE) {
      socket.emit('blocked', "❌ Not enough balance. Top up to play.");
      delete players[socket.id];
      delete currentCards[socket.id];
      delete playerUsernames[socket.id];
      lockedSeeds = lockedSeeds.filter(s => s !== seed);
      io.emit('lockedSeeds', lockedSeeds);
      io.emit('playerCount', Object.keys(players).length);
      return;
    }

    // Deduct fee
    db.data.users[username].balance -= ENTRY_FEE;
    await db.write();

    balanceMap[socket.id] = db.data.users[username].balance;
    socket.emit('balanceUpdate', balanceMap[socket.id]);
    io.emit('playerCount', Object.keys(players).length);
    io.emit('lockedSeeds', lockedSeeds);

    if (Object.keys(players).length === 1 && !countdownInterval && !gameStarted) {
      startCountdown();
    }
  });

  socket.on('balanceUpdate', async (newBalance) => {
    if (playerUsernames[socket.id]) {
      db.data.users[playerUsernames[socket.id]].balance = newBalance;
      await db.write();
    }
  });

  socket.emit('init', {
    calledNumbers: Array.from(calledNumbers),
    balance: balanceMap[socket.id] || 0,
    lockedSeeds
  });

  socket.on('checkBingo', async (markedArr) => {
    if (!currentCards[socket.id] || winner) return;
    const card = currentCards[socket.id];
    const markedSet = new Set(markedArr.map(Number));
    const valid = Array.from(markedSet).every(n => calledNumbers.has(n) || n === 'FREE');

    if (!valid) {
      socket.emit('blocked', "Not yet!");
      return;
    }

    if (checkBingo(card, markedSet)) {
      const playerCount = Object.keys(players).length;
      const winPoint = Math.floor(ENTRY_FEE * playerCount * 0.8);

      winner = { username: playerUsernames[socket.id], card };
      db.data.users[winner.username].balance += winPoint;
      await db.write();

      balanceMap[socket.id] = db.data.users[winner.username].balance;
      socket.emit('balanceUpdate', balanceMap[socket.id]);
      io.emit('winner', { username: winner.username, card, winPoint });

      clearInterval(callInterval);
      callInterval = null;
      io.emit('stopCalling');
      setTimeout(resetGame, 15000);
    } else {
      socket.emit('blocked', "Not yet!");
    }
  });

  socket.on('playAgain', () => {
    socket.emit('reset');
  });

  socket.on('endGame', () => {
    const seed = players[socket.id]?.seed;
    delete players[socket.id];
    delete currentCards[socket.id];
    delete playerUsernames[socket.id];
    if (seed) {
      lockedSeeds = lockedSeeds.filter(s => s !== seed);
      io.emit('lockedSeeds', lockedSeeds);
    }
    io.emit('playerCount', Object.keys(players).length);
  });

  socket.on('disconnect', () => {
    const seed = players[socket.id]?.seed;
    delete players[socket.id];
    delete currentCards[socket.id];
    delete playerUsernames[socket.id];
    if (seed) {
      lockedSeeds = lockedSeeds.filter(s => s !== seed);
      io.emit('lockedSeeds', lockedSeeds);
    }
    io.emit('playerCount', Object.keys(players).length);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Bingo server running at http://localhost:${PORT}`);
});
