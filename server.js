const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
    credentials: false
  }
});

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
const BOMB_TIMER = 2;
const BOMB_RADIUS = 3 * TILE_SIZE;
const BOMB_DAMAGE = 45;
const RESPAWN_DELAY = 2500;
const INVULNERABLE_AFTER_RESPAWN = 1500;

const rooms = new Map();

app.get("/health", (_req, res) => res.status(200).json({
  ok: true,
  service: "troll-wars-server",
  rooms: rooms.size,
  time: Date.now()
}));

// The same server can also serve the game when opened directly.
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

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
  return { width: WORLD_WIDTH, height: WORLD_HEIGHT, tileSize: TILE_SIZE, citadelRadius: CITADEL_RADIUS, tiles };
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
  const t = tileAtWorld(x, y);
  if (t.x < 0 || t.y < 0 || t.x >= WORLD_WIDTH || t.y >= WORLD_HEIGHT) return false;
  if (isInCitadel(x, y)) return true;
  const value = room.world.tiles[t.y][t.x];
  return value === 0 || value === 4;
}
function createPlayer(socketId) {
  const spawn = spawnPoint();
  return {
    id: socketId,
    name: `Troll_${Math.floor(1000 + Math.random() * 9000)}`,
    x: spawn.x, y: spawn.y,
    hp: 100, maxHp: 100,
    level: 1, exp: 0, kills: 0, deaths: 0,
    alive: true, respawnAt: 0,
    invulnerableUntil: Date.now() + INVULNERABLE_AFTER_RESPAWN,
    input: { up: false, down: false, left: false, right: false },
    facing: { x: 0, y: 1 },
    lastAttackAt: 0, lastBombAt: 0
  };
}
function publicPlayer(p) {
  return {
    id:p.id,name:p.name,x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,
    level:p.level,exp:p.exp,kills:p.kills,deaths:p.deaths,alive:p.alive,
    facing:p.facing,invulnerable:Date.now()<p.invulnerableUntil
  };
}
function publicBomb(b) {
  return { id:b.id,x:b.x,y:b.y,timer:Math.max(0,(b.explodeAt-Date.now())/1000) };
}
function publicOrb(o) { return { id:o.id,x:o.x,y:o.y,value:o.value }; }
function publicGrave(g) {
  return { x:g.x,y:g.y,name:g.name,level:g.level,reason:g.reason,createdAt:g.createdAt };
}
function addRoomLog(room,text) {
  for (const p of room.players.values()) io.to(p.id).emit("log",{text,time:Date.now()});
}
function roomState(room) {
  return {
    roomId:room.id,
    players:[...room.players.values()].map(publicPlayer),
    bombs:[...room.bombs.values()].map(publicBomb),
    orbs:[...room.orbs.values()].map(publicOrb),
    graves:room.graves.slice(-40).map(publicGrave)
  };
}
function broadcastRoom(room) {
  const state=roomState(room);
  for(const p of room.players.values()) io.to(p.id).emit("state",state);
}
function expNeeded(level){return 100+(level-1)*50}
function awardExp(room,p,amount){
  p.exp+=amount;
  while(p.exp>=expNeeded(p.level)){
    p.exp-=expNeeded(p.level);p.level++;p.maxHp+=10;p.hp=p.maxHp;
    addRoomLog(room,`🔥 ${p.name} reached Level ${p.level}`);
  }
}
function damagePlayer(room,victim,amount,killer,reason){
  if(!victim.alive||Date.now()<victim.invulnerableUntil)return;
  victim.hp-=amount;
  io.to(victim.id).emit("hit",{damage:amount,attacker:killer?.name||null});
  if(victim.hp>0)return;
  victim.hp=0;victim.alive=false;victim.deaths++;
  victim.respawnAt=Date.now()+RESPAWN_DELAY;
  victim.input={up:false,down:false,left:false,right:false};
  room.graves.push({x:victim.x,y:victim.y,name:victim.name,level:victim.level,reason:reason||"combat",createdAt:Date.now()});
  addRoomLog(room,`☠ ${victim.name} was defeated`);
  if(killer&&killer.id!==victim.id){killer.kills++;awardExp(room,killer,75+victim.level*15)}
  io.to(victim.id).emit("death",{respawnIn:RESPAWN_DELAY});
}
function respawnPlayer(room,p){
  Object.assign(p,spawnPoint(),{hp:p.maxHp,alive:true,respawnAt:0,invulnerableUntil:Date.now()+INVULNERABLE_AFTER_RESPAWN});
  addRoomLog(room,`↻ ${p.name} returned to the Citadel`);
}
function attack(room,a){
  const now=Date.now();
  if(!a.alive||now-a.lastAttackAt<ATTACK_COOLDOWN)return;
  a.lastAttackAt=now;
  io.to(a.id).emit("attackFx",{x:a.x,y:a.y,dir:a.facing});
  if(isInCitadel(a.x,a.y))return;
  const cosHalf=Math.cos(Math.PI*55/180);
  for(const target of room.players.values()){
    if(target.id===a.id||!target.alive||isInCitadel(target.x,target.y))continue;
    const dx=target.x-a.x,dy=target.y-a.y,d=Math.hypot(dx,dy);
    if(d>ATTACK_RANGE)continue;
    const dot=d?(dx*a.facing.x+dy*a.facing.y)/d:1;
    if(dot<cosHalf)continue;
    const damage=ATTACK_DAMAGE+(a.level-1)*3;
    damagePlayer(room,target,damage,a,"combat");
    io.to(a.id).emit("hitFx",{x:target.x,y:target.y,damage});
  }
}
function placeBomb(room,p){
  const now=Date.now();
  if(!p.alive||now-p.lastBombAt<BOMB_COOLDOWN||isInCitadel(p.x,p.y))return;
  p.lastBombAt=now;
  const id=room.nextBombId++;
  room.bombs.set(id,{id,ownerId:p.id,x:p.x,y:p.y,explodeAt:now+BOMB_TIMER*1000});
  addRoomLog(room,`💣 ${p.name} planted a bomb`);
}
function destroyTiles(room,x,y){
  const changed=[],minX=Math.max(0,Math.floor((x-BOMB_RADIUS)/TILE_SIZE)),maxX=Math.min(WORLD_WIDTH-1,Math.floor((x+BOMB_RADIUS)/TILE_SIZE));
  const minY=Math.max(0,Math.floor((y-BOMB_RADIUS)/TILE_SIZE)),maxY=Math.min(WORLD_HEIGHT-1,Math.floor((y+BOMB_RADIUS)/TILE_SIZE));
  for(let ty=minY;ty<=maxY;ty++)for(let tx=minX;tx<=maxX;tx++){
    const cx=tx*TILE_SIZE+16,cy=ty*TILE_SIZE+16;
    if(Math.hypot(cx-x,cy-y)<=BOMB_RADIUS&&!isInCitadel(cx,cy)&&room.world.tiles[ty][tx]!==4){
      room.world.tiles[ty][tx]=4;changed.push({x:tx,y:ty});
    }
  }
  if(changed.length)io.in(room.id).emit("terrainDestroyed",{tiles:changed});
}
function explodeBomb(room,b){
  room.bombs.delete(b.id);destroyTiles(room,b.x,b.y);
  addRoomLog(room,"💥 The ground was destroyed");
  io.in(room.id).emit("bombExploded",{x:b.x,y:b.y});
  for(const p of room.players.values()){
    if(!p.alive)continue;
    const d=Math.hypot(p.x-b.x,p.y-b.y);
    if(d<=BOMB_RADIUS&&!isInCitadel(p.x,p.y)){
      const owner=room.players.get(b.ownerId);
      damagePlayer(room,p,Math.max(8,Math.round(BOMB_DAMAGE*(1-d/BOMB_RADIUS))),owner?.id===p.id?null:owner,"bomb");
    }
  }
}
function updateRoom(room){
  const now=Date.now();
  for(const p of room.players.values()){
    if(!p.alive){if(now>=p.respawnAt)respawnPlayer(room,p);continue}
    let dx=(p.input.right?1:0)-(p.input.left?1:0),dy=(p.input.down?1:0)-(p.input.up?1:0);
    if(dx&&dy){dx*=Math.SQRT1_2;dy*=Math.SQRT1_2}
    if(dx||dy)p.facing={x:dx,y:dy};
    const nx=p.x+dx*MOVE_SPEED,ny=p.y+dy*MOVE_SPEED;
    if(isWalkable(room,nx,p.y))p.x=nx;
    if(isWalkable(room,p.x,ny))p.y=ny;
    for(const [id,o] of room.orbs)if(Math.hypot(o.x-p.x,o.y-p.y)<22){room.orbs.delete(id);awardExp(room,p,o.value);io.to(p.id).emit("orbCollected",{value:o.value})}
  }
  for(const b of [...room.bombs.values()])if(now>=b.explodeAt)explodeBomb(room,b);
  if(room.orbs.size<18&&Math.random()<.035){
    let x,y,tries=0;
    do{x=80+Math.random()*(WORLD_WIDTH*TILE_SIZE-160);y=80+Math.random()*(WORLD_HEIGHT*TILE_SIZE-160);tries++}
    while((!isWalkable(room,x,y)||isInCitadel(x,y))&&tries<40);
    if(tries<40){const id=room.nextOrbId++;room.orbs.set(id,{id,x,y,value:10})}
  }
}
function leaveRoom(socket){
  if(!socket.roomId)return;
  const room=rooms.get(socket.roomId);socket.roomId=null;if(!room)return;
  const player=room.players.get(socket.id);room.players.delete(socket.id);
  if(player)addRoomLog(room,`↘ ${player.name} left Guest Server ${room.id}`);
  if(room.hostId===socket.id)room.hostId=room.players.keys().next().value||null;
  if(room.players.size===0)rooms.delete(room.id);else broadcastRoom(room);
}

io.on("connection",socket=>{
  socket.on("guest:create",()=>{
    leaveRoom(socket);const room=createRoom(),p=createPlayer(socket.id);
    room.hostId=socket.id;room.players.set(socket.id,p);socket.roomId=room.id;
    socket.emit("guest:joined",{roomId:room.id,world:room.world,playerId:p.id,host:true});
    addRoomLog(room,`🌍 ${p.name} created Guest Server ${room.id}`);broadcastRoom(room);
  });
  socket.on("guest:join",raw=>{
    const id=String(raw||"").trim().toUpperCase();
    if(!/^[A-Z0-9]{6}$/.test(id))return socket.emit("guest:error",{message:"INVALID SERVER ID"});
    const room=rooms.get(id);
    if(!room)return socket.emit("guest:error",{message:"SERVER NOT FOUND"});
    if(room.players.size>=MAX_PLAYERS_PER_GUEST)return socket.emit("guest:error",{message:"SERVER IS FULL"});
    leaveRoom(socket);const p=createPlayer(socket.id);room.players.set(socket.id,p);socket.roomId=room.id;
    socket.emit("guest:joined",{roomId:room.id,world:room.world,playerId:p.id,host:room.hostId===socket.id});
    addRoomLog(room,`↗ ${p.name} joined Guest Server ${room.id}`);broadcastRoom(room);
  });
  socket.on("input",input=>{
    const room=socket.roomId?rooms.get(socket.roomId):null,p=room?.players.get(socket.id);
    if(!p||!p.alive)return;
    p.input={up:!!input?.up,down:!!input?.down,left:!!input?.left,right:!!input?.right};
  });
  socket.on("attack",()=>{const room=socket.roomId?rooms.get(socket.roomId):null,p=room?.players.get(socket.id);if(p)attack(room,p)});
  socket.on("bomb",()=>{const room=socket.roomId?rooms.get(socket.roomId):null,p=room?.players.get(socket.id);if(p)placeBomb(room,p)});
  socket.on("disconnect",()=>leaveRoom(socket));
});

setInterval(()=>{for(const room of rooms.values()){updateRoom(room);broadcastRoom(room)}},50);

server.listen(PORT,"0.0.0.0",()=>console.log(`Troll Wars Server listening on port ${PORT}`));
