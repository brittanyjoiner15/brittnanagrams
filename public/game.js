// ===== Config =====
const TILE_SIZE = 48;
const GRID_COLS = 42;
const GRID_ROWS = 42;
const CENTER_ROW = 20;
const CENTER_COL = 20;

// ===== State =====
const state = {
  playerId: null,
  playerName: null,
  roomCode: null,
  isHost: false,
  // Tiles in hand (unplaced): [{id, letter}]
  hand: [],
  // Tiles on board: Map of "r,c" -> {id, letter}
  boardTiles: new Map(),
  // Currently selected tile: {id, letter} or null
  // If selected from hand, it's in state.hand. If picked up from board, it's also in state.hand.
  selected: null,
  bunchCount: 0,
  players: [],
  gameStatus: 'lobby',
  toastTimer: null
};

// ===== Socket =====
const socket = io();

// ===== Dictionary =====
let dictionary = null;

async function loadDictionary() {
  if (dictionary) return dictionary;
  const res = await fetch('/words.txt');
  const text = await res.text();
  dictionary = new Set(text.split('\n').map(w => w.trim().toLowerCase()).filter(w => w.length >= 2));
  return dictionary;
}

// Pre-load dictionary as soon as the page loads
loadDictionary();

// Validate all words on the board. Returns a Set of "r,c" keys that belong to invalid words.
function validateBoard() {
  if (state.boardTiles.size === 0) return new Set();

  const invalidKeys = new Set();
  const dict = dictionary;
  if (!dict) return new Set(); // dict not loaded yet, skip

  // Group tiles by row and column
  const byRow = new Map(); // row -> [col, ...]
  const byCol = new Map(); // col -> [row, ...]
  for (const key of state.boardTiles.keys()) {
    const [r, c] = key.split(',').map(Number);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r).push(c);
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c).push(r);
  }
  for (const arr of byRow.values()) arr.sort((a, b) => a - b);
  for (const arr of byCol.values()) arr.sort((a, b) => a - b);

  // Split a sorted array of positions into consecutive runs
  function getRuns(positions) {
    const runs = [];
    let run = [positions[0]];
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] === positions[i - 1] + 1) {
        run.push(positions[i]);
      } else {
        runs.push(run);
        run = [positions[i]];
      }
    }
    runs.push(run);
    return runs;
  }

  // Check horizontal runs
  for (const [row, cols] of byRow) {
    for (const run of getRuns(cols)) {
      if (run.length < 2) continue;
      const word = run.map(c => state.boardTiles.get(`${row},${c}`).letter).join('').toLowerCase();
      if (!dict.has(word)) {
        for (const c of run) invalidKeys.add(`${row},${c}`);
      }
    }
  }

  // Check vertical runs
  for (const [col, rows] of byCol) {
    for (const run of getRuns(rows)) {
      if (run.length < 2) continue;
      const word = run.map(r => state.boardTiles.get(`${r},${col}`).letter).join('').toLowerCase();
      if (!dict.has(word)) {
        for (const r of run) invalidKeys.add(`${r},${col}`);
      }
    }
  }

  // Flag isolated tiles (no horizontal or vertical neighbor — not part of any word)
  for (const key of state.boardTiles.keys()) {
    const [r, c] = key.split(',').map(Number);
    const hasNeighbor =
      state.boardTiles.has(`${r},${c - 1}`) || state.boardTiles.has(`${r},${c + 1}`) ||
      state.boardTiles.has(`${r - 1},${c}`) || state.boardTiles.has(`${r + 1},${c}`);
    if (!hasNeighbor) invalidKeys.add(key);
  }

  return invalidKeys;
}

function highlightInvalidTiles(invalidKeys) {
  $('board').querySelectorAll('.tile').forEach(el => {
    const key = `${el.dataset.row},${el.dataset.col}`;
    el.classList.toggle('invalid', invalidKeys.has(key));
  });
}

function clearInvalidHighlights() {
  $('board').querySelectorAll('.tile.invalid').forEach(el => el.classList.remove('invalid'));
}

// ===== Util =====
function $(id) { return document.getElementById(id); }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
}

function showToast(msg, duration = 2500) {
  const t = $('game-toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
}

function showError(screenId, msg) {
  const el = $(`${screenId}-error`);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ===== Home Screen =====
$('btn-create').addEventListener('click', () => {
  const name = $('player-name').value.trim();
  if (!name) return showError('home', 'Enter your name first!');
  socket.emit('create-room', { name }, (res) => {
    if (!res.ok) return showError('home', res.error);
    state.playerId = res.playerId;
    state.playerName = name;
    state.roomCode = res.code;
    state.isHost = true;
    $('lobby-code').textContent = res.code;
    $('btn-start').style.display = 'block';
    $('waiting-msg').style.display = 'none';
    showScreen('lobby');
  });
});

$('btn-join').addEventListener('click', joinRoom);
$('room-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

function joinRoom() {
  const name = $('player-name').value.trim();
  const code = $('room-code-input').value.trim();
  if (!name) return showError('home', 'Enter your name first!');
  if (!code) return showError('home', 'Enter a room code!');
  socket.emit('join-room', { name, code }, (res) => {
    if (!res.ok) return showError('home', res.error);
    state.playerId = res.playerId;
    state.playerName = name;
    state.roomCode = res.code;
    state.isHost = false;
    $('lobby-code').textContent = res.code;
    $('btn-start').style.display = 'none';
    $('waiting-msg').style.display = 'block';
    showScreen('lobby');
  });
}

// ===== Lobby Screen =====
$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard?.writeText(state.roomCode).catch(() => {});
  $('btn-copy-code').textContent = '✓';
  setTimeout(() => ($('btn-copy-code').textContent = '📋'), 1500);
});

$('btn-start').addEventListener('click', () => {
  socket.emit('start-game', (res) => {
    if (res && !res.ok) showError('lobby', res.error);
  });
});

socket.on('room-update', (data) => {
  state.players = data.players || [];
  if (data.host === state.playerId) {
    state.isHost = true;
    $('btn-start').style.display = 'block';
    $('waiting-msg').style.display = 'none';
  }
  renderLobbyPlayers(data);

  // If status reverts to lobby (play again), reset and show lobby
  if (data.status === 'lobby' && $('screen-game').classList.contains('active')) {
    resetGameState();
    showScreen('lobby');
  }
});

socket.on('reset', () => {
  resetGameState();
  showScreen('lobby');
});

function renderLobbyPlayers(data) {
  const container = $('lobby-players');
  container.innerHTML = '';
  for (const p of data.players) {
    const div = document.createElement('div');
    div.className = 'lobby-player';
    const crown = p.id === data.host ? '<span class="crown">👑</span>' : '';
    const you = p.id === state.playerId ? '<span class="you-tag">you</span>' : '';
    div.innerHTML = `${crown}<span>${escHtml(p.name)}</span>${you}`;
    container.appendChild(div);
  }
}

// ===== Game Start =====
socket.on('game-started', (data) => {
  state.hand = [...data.hand];
  state.bunchCount = data.bunchCount;
  state.players = data.players || [];
  state.boardTiles = new Map();
  state.selected = null;
  state.gameStatus = 'playing';

  showScreen('game');
  renderHand();
  renderPlayersStrip();
  updateBunchDisplay();
  updateActionButtons();
  centerBoard();
});

function centerBoard() {
  const container = $('board-container');
  const boardPx = TILE_SIZE * GRID_COLS;
  const cx = CENTER_COL * TILE_SIZE - container.clientWidth / 2 + TILE_SIZE;
  const cy = CENTER_ROW * TILE_SIZE - container.clientHeight / 2 + TILE_SIZE;
  container.scrollLeft = Math.max(0, cx);
  container.scrollTop = Math.max(0, cy);
}

// ===== Board Interaction =====
$('board-container').addEventListener('click', (e) => {
  const container = $('board-container');
  const board = $('board');
  const boardRect = board.getBoundingClientRect();

  // Check if we clicked a tile element
  const tileEl = e.target.closest('.tile');
  if (tileEl) {
    const row = parseInt(tileEl.dataset.row);
    const col = parseInt(tileEl.dataset.col);
    handleBoardTileClick(row, col);
    return;
  }

  // Clicked empty space — calculate which cell
  const x = e.clientX - boardRect.left;
  const y = e.clientY - boardRect.top;
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);

  if (col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS) {
    handleBoardCellClick(row, col);
  }
});

function handleBoardTileClick(row, col) {
  const key = `${row},${col}`;
  const tile = state.boardTiles.get(key);
  if (!tile) return;

  if (state.selected) {
    // Swap: place selected here, pick up existing
    const selTile = state.selected;
    // Remove selected from hand
    state.hand = state.hand.filter(t => t.id !== selTile.id);
    // Remove existing from board
    state.boardTiles.delete(key);
    // Place selected on board
    state.boardTiles.set(key, selTile);
    // Add existing to hand as selected
    state.hand.push(tile);
    state.selected = tile;
  } else {
    // Pick up the board tile
    state.boardTiles.delete(key);
    state.hand.push(tile);
    state.selected = tile;
  }
  clearInvalidHighlights();
  renderBoard();
  renderHand();
  updateActionButtons();
}

function handleBoardCellClick(row, col) {
  if (!state.selected) return;
  const key = `${row},${col}`;
  if (state.boardTiles.has(key)) return; // occupied

  // Place selected tile on board
  const tile = state.selected;
  state.hand = state.hand.filter(t => t.id !== tile.id);
  state.boardTiles.set(key, tile);
  state.selected = null;

  clearInvalidHighlights();
  renderBoard();
  renderHand();
  updateActionButtons();
}

// ===== Board Rendering =====
function renderBoard() {
  const board = $('board');
  // Remove old tile elements
  board.querySelectorAll('.tile').forEach(el => el.remove());

  for (const [key, tile] of state.boardTiles) {
    const [row, col] = key.split(',').map(Number);
    const el = createBoardTileEl(tile, row, col);
    board.appendChild(el);
  }
}

function createBoardTileEl(tile, row, col) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.textContent = tile.letter;
  el.dataset.row = row;
  el.dataset.col = col;
  el.dataset.id = tile.id;
  el.style.left = `${col * TILE_SIZE + 2}px`;
  el.style.top = `${row * TILE_SIZE + 2}px`;
  return el;
}

// ===== Hand Rendering =====
function renderHand() {
  const container = $('hand-tiles');
  container.innerHTML = '';

  for (const tile of state.hand) {
    const el = document.createElement('div');
    el.className = 'hand-tile' + (state.selected?.id === tile.id ? ' selected' : '');
    el.textContent = tile.letter;
    el.dataset.id = tile.id;
    el.addEventListener('click', () => handleHandTileClick(tile));
    container.appendChild(el);
  }

  $('hand-count').textContent = state.hand.length;
}

function handleHandTileClick(tile) {
  if (state.selected?.id === tile.id) {
    // Deselect
    state.selected = null;
  } else {
    state.selected = tile;
  }
  renderHand();
  updateActionButtons();
}

// ===== Players Strip =====
function renderPlayersStrip() {
  const strip = $('players-strip');
  strip.innerHTML = '';
  for (const p of state.players) {
    const el = document.createElement('div');
    el.className = 'player-chip' + (p.id === state.playerId ? ' me' : '');
    el.dataset.playerId = p.id;
    el.innerHTML = `<span>${escHtml(p.name)}</span><span class="chip-count">${p.tileCount ?? '?'}</span>`;
    strip.appendChild(el);
  }
}

function updatePlayerChip(playerId, tileCount) {
  const chip = $('players-strip').querySelector(`[data-player-id="${playerId}"]`);
  if (chip) chip.querySelector('.chip-count').textContent = tileCount;
}

function updateAllChips(players) {
  for (const p of players) updatePlayerChip(p.id, p.tileCount);
}

// ===== Action Buttons =====
function updateActionButtons() {
  const handEmpty = state.hand.length === 0;
  const canBananas = handEmpty && state.bunchCount < state.players.length;
  const canPeel = handEmpty && !canBananas;

  $('btn-peel').disabled = !canPeel;
  $('btn-bananas').disabled = !canBananas;
  $('btn-dump').disabled = !(state.selected && state.hand.includes(state.selected));
}

function updateBunchDisplay() {
  $('bunch-count').textContent = state.bunchCount;
  updateActionButtons();
}

// ===== Game Actions =====
$('btn-peel').addEventListener('click', () => {
  const invalidKeys = validateBoard();
  if (invalidKeys.size > 0) {
    highlightInvalidTiles(invalidKeys);
    showToast(`Fix your words first! (${invalidKeys.size} tile${invalidKeys.size > 1 ? 's' : ''} highlighted)`, 3500);
    return;
  }
  clearInvalidHighlights();
  $('btn-peel').disabled = true;
  socket.emit('peel', (res) => {
    if (res && !res.ok) {
      showToast(res.error);
      updateActionButtons();
    }
  });
});

$('btn-bananas').addEventListener('click', () => {
  if (state.hand.length > 0) return showToast('You still have tiles in your hand!');
  const invalidKeys = validateBoard();
  if (invalidKeys.size > 0) {
    highlightInvalidTiles(invalidKeys);
    showToast(`Fix your words first! (${invalidKeys.size} tile${invalidKeys.size > 1 ? 's' : ''} highlighted)`, 3500);
    return;
  }
  clearInvalidHighlights();
  $('btn-bananas').disabled = true;
  socket.emit('bananas', (res) => {
    if (res && !res.ok) {
      showToast(res.error);
      updateActionButtons();
    }
  });
});

$('btn-dump').addEventListener('click', () => {
  if (!state.selected) return showToast('Select a tile from your hand first.');
  if (!state.hand.find(t => t.id === state.selected.id)) {
    return showToast('Can only dump tiles from your hand.');
  }
  const tileId = state.selected.id;
  socket.emit('dump', { tileId }, (res) => {
    if (!res.ok) return showToast(res.error);
    // Remove dumped tile from hand
    state.hand = state.hand.filter(t => t.id !== tileId);
    // Add new tiles to hand
    state.hand.push(...res.newTiles);
    state.bunchCount = res.bunchCount;
    state.selected = null;
    renderHand();
    updateBunchDisplay();
    showToast(`Dumped! Got ${res.newTiles.map(t => t.letter).join(', ')}`);
  });
});

$('btn-grab-all').addEventListener('click', () => {
  // Pick up all tiles from the board back into hand
  for (const [, tile] of state.boardTiles) {
    state.hand.push(tile);
  }
  state.boardTiles.clear();
  state.selected = null;
  renderBoard();
  renderHand();
  updateActionButtons();
  showToast('All tiles back in hand.');
});

// ===== Socket Events (game) =====
socket.on('peel-result', (data) => {
  // Add new tile to hand
  state.hand.push(data.newTile);
  state.bunchCount = data.bunchCount;
  if (data.players) {
    state.players = data.players;
    renderPlayersStrip();
  }
  renderHand();
  updateBunchDisplay();

  const isMe = data.peeler === state.playerName;
  showToast(isMe ? `You peeled! Everyone gets a tile.` : `${data.peeler} peeled! You got: ${data.newTile.letter}`);
});

socket.on('dump-result', (data) => {
  // handled in callback above
  state.bunchCount = data.bunchCount;
  updateBunchDisplay();
});

socket.on('state-update', (data) => {
  state.bunchCount = data.bunchCount;
  if (data.players) {
    state.players = data.players;
    updateAllChips(data.players);
    // Update my chip
    const me = data.players.find(p => p.id === state.playerId);
    if (me) {
      const myCount = state.hand.length + state.boardTiles.size;
      // Server count may differ since we have local state; just update others
    }
  }
  updateBunchDisplay();
});

socket.on('player-left', (data) => {
  showToast(`${data.name} left the game.`);
  if (data.bunchCount !== undefined) {
    state.bunchCount = data.bunchCount;
    updateBunchDisplay();
  }
  if (data.players) {
    state.players = data.players;
    renderPlayersStrip();
  }
});

// ===== Game Over =====
socket.on('game-over', (data) => {
  state.gameStatus = 'finished';
  const isWinner = data.winnerId === state.playerId;
  $('winner-text').textContent = isWinner ? '🍌 BANANAS! You win!' : `🍌 ${data.winner} wins!`;
  $('gameover-sub').textContent = isWinner
    ? 'You used all your tiles first. Well done!'
    : `${data.winner} used all their tiles first.`;
  if (state.isHost) {
    $('btn-play-again').style.display = 'block';
  } else {
    $('btn-play-again').style.display = 'none';
  }
  showScreen('gameover');
});

$('btn-play-again').addEventListener('click', () => {
  socket.emit('play-again');
});

$('btn-home').addEventListener('click', () => {
  // Just go back to home screen locally — doesn't leave the room
  resetGameState();
  showScreen('home');
});

// ===== Helpers =====
function resetGameState() {
  state.hand = [];
  state.boardTiles = new Map();
  state.selected = null;
  state.bunchCount = 0;
  state.gameStatus = 'lobby';
  $('board').innerHTML = '';
  $('hand-tiles').innerHTML = '';
  $('players-strip').innerHTML = '';
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== Keyboard support (desktop) =====
document.addEventListener('keydown', (e) => {
  if (!$('screen-game').classList.contains('active')) return;
  // Arrow keys to nudge board scroll
  const c = $('board-container');
  if (e.key === 'Escape') {
    state.selected = null;
    renderHand();
    updateActionButtons();
  }
});

// ===== Prevent pull-to-refresh on game screen =====
document.addEventListener('touchmove', (e) => {
  if ($('screen-game').classList.contains('active')) {
    // Allow scroll inside board and hand
    if (!e.target.closest('#board-container') && !e.target.closest('#hand-tiles')) {
      e.preventDefault();
    }
  }
}, { passive: false });

// ===== Responsive tile size =====
(function detectTileSize() {
  if (window.innerWidth >= 600) {
    // CSS handles it via media query, but we need to sync JS constant
    // Recalculate on resize (only matters for initial center)
  }
})();

window.addEventListener('resize', () => {
  if ($('screen-game').classList.contains('active')) {
    // Re-center on resize (optional)
  }
});
