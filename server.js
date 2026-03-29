const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const LETTER_DIST = {
  A:13, B:3, C:3, D:6, E:18, F:3, G:4, H:3, I:12, J:2, K:2,
  L:5, M:3, N:8, O:11, P:3, Q:2, R:9, S:6, T:9, U:6, V:3, W:3, X:2, Y:3, Z:2
};

// Global tile registry: tileId -> { id, letter }
const tileRegistry = new Map();

function createBunch() {
  const bunch = [];
  let id = 0;
  for (const [letter, count] of Object.entries(LETTER_DIST)) {
    for (let i = 0; i < count; i++) {
      const tile = { id: `t${id++}`, letter };
      bunch.push(tile);
      tileRegistry.set(tile.id, tile);
    }
  }
  shuffle(bunch);
  return bunch;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function startingCount(numPlayers) {
  if (numPlayers <= 4) return 21;
  if (numPlayers <= 6) return 15;
  return 11;
}

// rooms: code -> { code, players, bunch, status, host }
// player: { id, name, tileIds: Set }
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function playerList(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, tileCount: p.tileIds.size }));
}

io.on('connection', (socket) => {
  let myRoom = null;

  const room = () => rooms.get(myRoom);
  const me = () => room()?.players.find(p => p.id === socket.id);

  socket.on('create-room', ({ name }, cb) => {
    const code = genCode();
    rooms.set(code, {
      code,
      players: [{ id: socket.id, name: name.trim().slice(0, 20), tileIds: new Set() }],
      bunch: [],
      status: 'lobby',
      host: socket.id
    });
    myRoom = code;
    socket.join(code);
    cb({ ok: true, code, playerId: socket.id });
    emitRoomUpdate(code);
  });

  socket.on('join-room', ({ name, code }, cb) => {
    const c = code.trim().toUpperCase();
    const r = rooms.get(c);
    if (!r) return cb({ ok: false, error: 'Room not found.' });
    if (r.status !== 'lobby') return cb({ ok: false, error: 'Game already started.' });
    if (r.players.length >= 8) return cb({ ok: false, error: 'Room full (max 8).' });

    r.players.push({ id: socket.id, name: name.trim().slice(0, 20), tileIds: new Set() });
    myRoom = c;
    socket.join(c);
    cb({ ok: true, code: c, playerId: socket.id });
    emitRoomUpdate(c);
  });

  socket.on('start-game', (cb) => {
    const r = room();
    if (!r || r.host !== socket.id) return cb?.({ ok: false, error: 'Only the host can start.' });
    if (r.players.length < 2) return cb?.({ ok: false, error: 'Need at least 2 players.' });

    r.bunch = createBunch();
    r.status = 'playing';
    const count = startingCount(r.players.length);

    for (const player of r.players) {
      const hand = r.bunch.splice(0, count);
      player.tileIds = new Set(hand.map(t => t.id));
      io.to(player.id).emit('game-started', {
        hand,
        bunchCount: r.bunch.length,
        players: playerList(r)
      });
    }
    cb?.({ ok: true });
  });

  socket.on('peel', (cb) => {
    const r = room();
    if (!r || r.status !== 'playing') return;
    const player = me();
    if (!player) return;

    if (r.bunch.length < r.players.length) {
      return cb?.({ ok: false, error: `Only ${r.bunch.length} tile(s) left — call BANANAS!` });
    }

    const peelerName = player.name;
    for (const p of r.players) {
      const tile = r.bunch.shift();
      p.tileIds.add(tile.id);
      io.to(p.id).emit('peel-result', {
        peeler: peelerName,
        newTile: tile,
        bunchCount: r.bunch.length,
        players: playerList(r)
      });
    }
    cb?.({ ok: true });
  });

  socket.on('dump', ({ tileId }, cb) => {
    const r = room();
    if (!r || r.status !== 'playing') return;
    const player = me();
    if (!player) return;

    if (!player.tileIds.has(tileId)) return cb?.({ ok: false, error: 'You do not have that tile.' });
    if (r.bunch.length < 3) return cb?.({ ok: false, error: `Need 3 tiles in bunch to dump (have ${r.bunch.length}).` });

    const tile = tileRegistry.get(tileId);
    if (!tile) return cb?.({ ok: false, error: 'Tile data missing.' });

    player.tileIds.delete(tileId);
    // Insert tile at random position in bunch
    const insertAt = Math.floor(Math.random() * (r.bunch.length + 1));
    r.bunch.splice(insertAt, 0, tile);

    const newTiles = r.bunch.splice(0, 3);
    for (const t of newTiles) player.tileIds.add(t.id);

    cb?.({ ok: true, newTiles, bunchCount: r.bunch.length });

    // Tell others the bunch count changed
    for (const p of r.players) {
      if (p.id !== socket.id) {
        io.to(p.id).emit('state-update', { bunchCount: r.bunch.length, players: playerList(r) });
      }
    }
  });

  socket.on('bananas', (cb) => {
    const r = room();
    if (!r || r.status !== 'playing') return;
    const player = me();
    if (!player) return;

    if (r.bunch.length >= r.players.length) {
      return cb?.({ ok: false, error: `Bunch has ${r.bunch.length} tiles — use PEEL first!` });
    }

    r.status = 'finished';
    io.to(myRoom).emit('game-over', { winner: player.name, winnerId: socket.id });
    cb?.({ ok: true });
  });

  socket.on('play-again', () => {
    const r = room();
    if (!r || r.host !== socket.id) return;
    r.status = 'lobby';
    r.bunch = [];
    for (const p of r.players) p.tileIds = new Set();
    emitRoomUpdate(myRoom);
    io.to(myRoom).emit('reset');
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const r = rooms.get(myRoom);
    if (!r) return;

    const player = r.players.find(p => p.id === socket.id);
    const name = player?.name ?? 'A player';
    r.players = r.players.filter(p => p.id !== socket.id);

    if (r.players.length === 0) {
      rooms.delete(myRoom);
      return;
    }

    if (r.host === socket.id) r.host = r.players[0].id;

    // Return tiles to bunch if game was in progress
    if (r.status === 'playing' && player) {
      for (const tileId of player.tileIds) {
        const tile = tileRegistry.get(tileId);
        if (tile) r.bunch.push(tile);
      }
      shuffle(r.bunch);
    }

    io.to(myRoom).emit('player-left', { name, bunchCount: r.bunch.length, players: playerList(r) });
    emitRoomUpdate(myRoom);
  });

  function emitRoomUpdate(code) {
    const r = rooms.get(code);
    if (!r) return;
    io.to(code).emit('room-update', {
      players: r.players.map(p => ({ id: p.id, name: p.name })),
      host: r.host,
      status: r.status
    });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Bananagrams running at http://localhost:${PORT}`);
});
