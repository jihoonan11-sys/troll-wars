const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TILE_SIZE = 32;
const WORLD_WIDTH = 80;
const WORLD_HEIGHT = 60;
const CITADEL_RADIUS = 7;
const MAX_PLAYERS_PER_GUEST = 16;
const MOVE_SPEED = 4.2;
const ATTACK_RANGE = 58;
const ATTACK_COOLDOWN = 350;
const ATTACK_DAMAGE = 24;
const BOMB_COOLDOWN = 1000;
const BOMB_TIMER = 2.0;
const BOMB_RADIUS = 3 * TILE_SIZE;
const BOMB_DAMAGE = 45;
const RESPAWN_DELAY = 2500;
const INVULNERABLE_AFTER_RESPAWN = 1500;

const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

function createWorld() {
  const tiles = [];
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    tiles[y] = [];
    for (let x = 0; x < WORLD_WIDTH; x++) {
      const dx = x - WORLD_WIDTH / 2;
      const dy = y - WORLD_HEIGHT / 2;
      const distance = Math.hypot(dx, dy);
      let tile = 0;
      if (distance >= CITADEL_RADIUS) {
        const roll = Math.random();
        if (roll < 0.07) tile = 1;
        else if (roll < 0.14) tile = 2;
        else if (roll < 0.17) tile = 3;
      }
      tiles[y].push(tile);
    }
  }
  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    tileSize: TILE_SIZE,
    citadelRadius: CITADEL_RADIUS,
    tiles
  };
}

function createRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do {
    id = "";
    for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (rooms.has(id));
  return id;
}

function createRoom() {
  const room = {
    id: createRoomId(),
    type: "guest",
    world: createWorld(),
    players: new Map(),
    bombs: new Map(),
    graves: [],
    orbs: new Map(),
    nextBombId: 1,
    nextOrbId: 1,
    hostId: null,
    createdAt: Date.now()
  };
  rooms.set(room.id, room);
  return room;
}

function spawnPoint() {
  return { x: WORLD_WIDTH * TILE_SIZE / 2, y: WORLD_HEIGHT * TILE_SIZE / 2 };
}

function isInCitadel(x, y) {
  const s = spawnPoint();
  return Math.hypot(x - s.x, y - s.y) < CITADEL_RADIUS * TILE_SIZE;
}

function tileAtWorld(x, y) {
  return { x: Math.floor(x / TILE_SIZE), y: Math.floor(y / TILE_SIZE) };
}

function isWalkable(room, x, y) {
  const tile = tileAtWorld(x, y);
  if (tile.x < 0 || tile.y < 0 || tile.x >= WORLD_WIDTH || tile.y >= WORLD_HEIGHT) return false;
  if (isInCitadel(x, y)) return true;
  const value = room.world.tiles[tile.y][tile.x];
  return value === 0 || value === 4;
}

function createPlayer(socketId) {
  const spawn = spawnPoint();
  return {
    id: socketId,
    name: `Troll_${Math.floor(1000 + Math.random() * 9000)}`,
    x: spawn.x,
    y: spawn.y,
    hp: 100,
    maxHp: 100,
    level: 1,
    exp: 0,
    kills: 0,
    deaths: 0,
    alive: true,
    respawnAt: 0,
    invulnerableUntil: Date.now() + INVULNERABLE_AFTER_RESPAWN,
    input: { up: false, down: false, left: false, right: false },
    facing: { x: 0, y: 1 },
    lastAttackAt: 0,
    lastBombAt: 0
  };
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    hp: player.hp,
    maxHp: player.maxHp,
    level: player.level,
    exp: player.exp,
    kills: player.kills,
    deaths: player.deaths,
    alive: player.alive,
    facing: player.facing,
    invulnerable: Date.now() < player.invulnerableUntil
  };
}

function publicBomb(bomb) {
  return { id: bomb.id, x: bomb.x, y: bomb.y, timer: Math.max(0, (bomb.explodeAt - Date.now()) / 1000) };
}

function publicOrb(orb) {
  return { id: orb.id, x: orb.x, y: orb.y, value: orb.value };
}

function publicGrave(grave) {
  return { x: grave.x, y: grave.y, name: grave.name, level: grave.level, reason: grave.reason, createdAt: grave.createdAt };
}

function addRoomLog(room, text) {
  for (const player of room.players.values()) io.to(player.id).emit("log", { text, time: Date.now() });
}

function roomState(room) {
  return {
    roomId: room.id,
    players: [...room.players.values()].map(publicPlayer),
    bombs: [...room.bombs.values()].map(publicBomb),
    orbs: [...room.orbs.values()].map(publicOrb),
    graves: room.graves.slice(-40).map(publicGrave)
  };
}

function broadcastRoom(room) {
  const state = roomState(room);
  for (const player of room.players.values()) io.to(player.id).emit("state", state);
}

function awardExp(room, player, amount) {
  player.exp += amount;
  let leveled = false;
  while (player.exp >= expNeeded(player.level)) {
    player.exp -= expNeeded(player.level);
    player.level++;
    player.maxHp += 10;
    player.hp = player.maxHp;
    leveled = true;
    addRoomLog(room, `🔥 ${player.name} reached Level ${player.level}`);
  }
  return leveled;
}

function expNeeded(level) {
  return 100 + (level - 1) * 50;
}

function damagePlayer(room, victim, amount, killer, reason) {
  if (!victim.alive || Date.now() < victim.invulnerableUntil) return false;
  victim.hp -= amount;
  io.to(victim.id).emit("hit", { damage: amount, attacker: killer?.name || null });
  if (victim.hp > 0) return true;

  victim.hp = 0;
  victim.alive = false;
  victim.deaths++;
  victim.respawnAt = Date.now() + RESPAWN_DELAY;
  victim.input = { up: false, down: false, left: false, right: false };

  const killerName = killer ? killer.name : "the wilderness";
  const reasonText = reason || "combat";
  room.graves.push({
    x: victim.x,
    y: victim.y,
    name: victim.name,
    level: victim.level,
    reason: reasonText,
    createdAt: Date.now()
  });
  addRoomLog(room, `☠ ${victim.name} was defeated by ${killerName}`);
  if (killer && killer.id !== victim.id) {
    killer.kills++;
    awardExp(room, killer, 75 + victim.level * 15);
  }
  io.to(victim.id).emit("death", { respawnIn: RESPAWN_DELAY });
  return true;
}

function respawnPlayer(room, player) {
  const spawn = spawnPoint();
  player.x = spawn.x;
  player.y = spawn.y;
  player.hp = player.maxHp;
  player.alive = true;
  player.respawnAt = 0;
  player.invulnerableUntil = Date.now() + INVULNERABLE_AFTER_RESPAWN;
  addRoomLog(room, `↻ ${player.name} returned to the Citadel`);
}

function attack(room, attacker) {
  const now = Date.now();
  if (!attacker.alive || now - attacker.lastAttackAt < ATTACK_COOLDOWN) return;
  attacker.lastAttackAt = now;
  io.to(attacker.id).emit("attackFx", { x: attacker.x, y: attacker.y, dir: attacker.facing });

  if (isInCitadel(attacker.x, attacker.y)) return;

  const facing = attacker.facing;
  const cosHalfArc = Math.cos(Math.PI * 55 / 180);

  for (const target of room.players.values()) {
    if (target.id === attacker.id || !target.alive) continue;
    if (isInCitadel(target.x, target.y)) continue;
    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= ATTACK_RANGE) {
      const dot = distance === 0 ? 1 : (dx * facing.x + dy * facing.y) / distance;
      if (dot < cosHalfArc) continue;
      const damage = ATTACK_DAMAGE + (attacker.level - 1) * 3;
      damagePlayer(room, target, damage, attacker, "combat");
      io.to(attacker.id).emit("hitFx", { x: target.x, y: target.y, damage });
    }
  }
}

function placeBomb(room, player) {
  const now = Date.now();
  if (!player.alive || now - player.lastBombAt < BOMB_COOLDOWN || isInCitadel(player.x, player.y)) return;
  player.lastBombAt = now;
  const id = room.nextBombId++;
  room.bombs.set(id, { id, ownerId: player.id, x: player.x, y: player.y, explodeAt: now + BOMB_TIMER * 1000 });
  addRoomLog(room, `💣 ${player.name} planted a bomb`);
}

function destroyTiles(room, x, y) {
  const changed = [];
  const minX = Math.max(0, Math.floor((x - BOMB_RADIUS) / TILE_SIZE));
  const maxX = Math.min(WORLD_WIDTH - 1, Math.floor((x + BOMB_RADIUS) / TILE_SIZE));
  const minY = Math.max(0, Math.floor((y - BOMB_RADIUS) / TILE_SIZE));
  const maxY = Math.min(WORLD_HEIGHT - 1, Math.floor((y + BOMB_RADIUS) / TILE_SIZE));
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const cx = tx * TILE_SIZE + TILE_SIZE / 2;
      const cy = ty * TILE_SIZE + TILE_SIZE / 2;
      if (Math.hypot(cx - x, cy - y) <= BOMB_RADIUS && !isInCitadel(cx, cy) && room.world.tiles[ty][tx] !== 4) {
        room.world.tiles[ty][tx] = 4;
        changed.push({ x: tx, y: ty });
      }
    }
  }
  if (changed.length) io.in(room.id).emit("terrainDestroyed", { tiles: changed });
}

function explodeBomb(room, bomb) {
  room.bombs.delete(bomb.id);
  destroyTiles(room, bomb.x, bomb.y);
  addRoomLog(room, "💥 The ground was destroyed");
  io.in(room.id).emit("bombExploded", { x: bomb.x, y: bomb.y });

  for (const player of room.players.values()) {
    if (!player.alive) continue;
    const distance = Math.hypot(player.x - bomb.x, player.y - bomb.y);
    if (distance <= BOMB_RADIUS && !isInCitadel(player.x, player.y)) {
      const damage = Math.max(8, Math.round(BOMB_DAMAGE * (1 - distance / BOMB_RADIUS)));
      const owner = room.players.get(bomb.ownerId);
      damagePlayer(room, player, damage, owner?.id === player.id ? null : owner, "bomb");
    }
  }
}

function updateRoom(room) {
  const now = Date.now();
  for (const player of room.players.values()) {
    if (!player.alive) {
      if (now >= player.respawnAt) respawnPlayer(room, player);
      continue;
    }
    let dx = 0, dy = 0;
    if (player.input.up) dy--;
    if (player.input.down) dy++;
    if (player.input.left) dx--;
    if (player.input.right) dx++;
    if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
    const nextX = player.x + dx * MOVE_SPEED;
    const nextY = player.y + dy * MOVE_SPEED;
    if (isWalkable(room, nextX, player.y)) player.x = nextX;
    if (isWalkable(room, player.x, nextY)) player.y = nextY;

    for (const [id, orb] of room.orbs) {
      if (Math.hypot(orb.x - player.x, orb.y - player.y) < 22) {
        room.orbs.delete(id);
        awardExp(room, player, orb.value);
        io.to(player.id).emit("orbCollected", { value: orb.value });
      }
    }
  }

  for (const bomb of [...room.bombs.values()]) {
    if (now >= bomb.explodeAt) explodeBomb(room, bomb);
  }

  if (room.orbs.size < 18 && Math.random() < 0.035) {
    let x, y, tries = 0;
    do {
      x = 80 + Math.random() * (WORLD_WIDTH * TILE_SIZE - 160);
      y = 80 + Math.random() * (WORLD_HEIGHT * TILE_SIZE - 160);
      tries++;
    } while ((!isWalkable(room, x, y) || isInCitadel(x, y)) && tries < 40);
    if (tries < 40) {
      const id = room.nextOrbId++;
      room.orbs.set(id, { id, x, y, value: 10 });
    }
  }
}

function leaveRoom(socket) {
  if (!socket.roomId) return;
  const room = rooms.get(socket.roomId);
  socket.roomId = null;
  if (!room) return;
  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  if (player) addRoomLog(room, `↘ ${player.name} left Guest Server ${room.id}`);
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value || null;
  if (room.players.size === 0) {
    rooms.delete(room.id);
  } else {
    broadcastRoom(room);
  }
}

io.on("connection", socket => {
  socket.on("guest:create", () => {
    leaveRoom(socket);
    const room = createRoom();
    const player = createPlayer(socket.id);
    room.hostId = socket.id;
    room.players.set(socket.id, player);
    socket.roomId = room.id;
    socket.emit("guest:joined", { roomId: room.id, world: room.world, playerId: player.id, host: true });
    addRoomLog(room, `🌍 ${player.name} created Guest Server ${room.id}`);
    broadcastRoom(room);
  });

  socket.on("guest:join", rawId => {
    const roomId = String(rawId || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
      socket.emit("guest:error", { message: "INVALID SERVER ID" });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("guest:error", { message: "SERVER NOT FOUND" });
      return;
    }
    if (room.players.size >= MAX_PLAYERS_PER_GUEST) {
      socket.emit("guest:error", { message: "SERVER IS FULL" });
      return;
    }
    leaveRoom(socket);
    const player = createPlayer(socket.id);
    room.players.set(socket.id, player);
    socket.roomId = room.id;
    socket.emit("guest:joined", { roomId: room.id, world: room.world, playerId: player.id, host: room.hostId === socket.id });
    addRoomLog(room, `↗ ${player.name} joined Guest Server ${room.id}`);
    broadcastRoom(room);
  });

  socket.on("input", input => {
    const room = socket.roomId ? rooms.get(socket.roomId) : null;
    const player = room?.players.get(socket.id);
    if (!player || !player.alive) return;
    player.input = {
      up: !!input?.up,
      down: !!input?.down,
      left: !!input?.left,
      right: !!input?.right
    };
    let fx = 0, fy = 0;
    if (player.input.up) fy--;
    if (player.input.down) fy++;
    if (player.input.left) fx--;
    if (player.input.right) fx++;
    if (fx || fy) {
      if (fx && fy) { fx *= Math.SQRT1_2; fy *= Math.SQRT1_2; }
      player.facing = { x: fx, y: fy };
    }
  });

  socket.on("attack", () => {
    const room = socket.roomId ? rooms.get(socket.roomId) : null;
    const player = room?.players.get(socket.id);
    if (player) attack(room, player);
  });

  socket.on("bomb", () => {
    const room = socket.roomId ? rooms.get(socket.roomId) : null;
    const player = room?.players.get(socket.id);
    if (player) placeBomb(room, player);
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

setInterval(() => {
  for (const room of rooms.values()) {
    updateRoom(room);
    broadcastRoom(room);
  }
}, 50);

server.listen(PORT, () => {
  console.log(`Troll Wars Guest Server running at http://localhost:${PORT}`);
});
