import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { advance, newRun, STEP } from "./game.js";

const data = process.env.DATA_DIR || "data";
const file = join(data, "flight.json");
await mkdir(data, { recursive: true });
const players = new Map();
try {
  for (const player of JSON.parse(await readFile(file, "utf8"))) players.set(player.token, player);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const assets = {
  "/": ["public/index.html", "text/html"],
  "/style.css": ["public/style.css", "text/css"],
  "/app.js": ["public/app.js", "text/javascript"],
  "/game.js": ["game.js", "text/javascript"],
};
const server = createServer(async (req, res) => {
  if (req.url === "/api/health") return res.end("ok");
  const asset = req.method === "GET" && Object.hasOwn(assets, req.url) && assets[req.url];
  if (!asset) return res.writeHead(404).end();
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    res.writeHead(200, {
      "Content-Type": asset[1] + "; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(500).end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const active = new Map();
let dirty = false;
let writing;
function save() {
  if (writing || !dirty) return writing;
  dirty = false;
  const snapshot = JSON.stringify([...players.values()]);
  writing = writeFile(file + ".tmp", snapshot, { mode: 0o600 })
    .then(() => rename(file + ".tmp", file))
    .catch((error) => {
      dirty = true;
      console.error(JSON.stringify({ event: "save_error", code: error.code }));
    })
    .finally(() => {
      writing = null;
    });
  return writing;
}

const send = (socket, value) => {
  if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 64_000)
    socket.send(JSON.stringify(value));
};
function broadcast() {
  const visible = [...active.keys()].map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    ...p.run,
  }));
  const leaders = [...players.values()]
    .sort(
      (a, b) =>
        b.best - a.best ||
        Number(active.has(b)) - Number(active.has(a)) ||
        a.name.localeCompare(b.name, "ru"),
    )
    .slice(0, 10)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, best: p.best, online: active.has(p) }));
  for (const sockets of active.values()) {
    for (const socket of sockets) send(socket, { type: "state", visible, leaders });
  }
}
server.on("upgrade", (req, socket, head) => {
  const origin =
    process.env.ALLOWED_ORIGIN || (req.headers.host ? "http://" + req.headers.host : "");
  if (req.url !== "/play" || req.headers.origin !== origin || wss.clients.size >= 48) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (socket) => {
  let player;
  let lastFlap = 0;
  socket.alive = true;
  socket.on("pong", () => {
    socket.alive = true;
    if (socket.pingState && socket.pingState.run.version >= socket.checkpoint?.run.version) {
      socket.checkpoint = socket.pingState;
    }
  });
  socket.on("error", () => socket.terminate());
  const deadline = setTimeout(() => {
    if (!player) socket.close(1008, "Join required");
  }, 5000);
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (!player && msg.type === "join") {
      const existing = typeof msg.token === "string" && players.get(msg.token);
      const name = typeof msg.name === "string" ? msg.name.trim().replace(/\s+/g, " ") : "";
      if (!existing && (name.length < 2 || name.length > 24 || players.size >= 500)) {
        send(socket, {
          type: "error",
          message: "Введите имя от 2 до 24 символов. Максимум 500 профилей.",
        });
        return;
      }
      player = existing || {
        token: randomUUID(),
        id: randomUUID(),
        name,
        best: 0,
        color: players.size % 8,
        run: newRun(),
      };
      players.set(player.token, player);
      if (!active.has(player)) active.set(player, new Set());
      active.get(player).add(socket);
      if (player.run.phase === "flying" && active.get(player).size === 1)
        player.run.phase = "paused";
      socket.player = player;
      socket.checkpoint = { run: { ...player.run }, best: player.best };
      clearTimeout(deadline);
      dirty = true;
      send(socket, { type: "joined", id: player.id, token: player.token });
      broadcast();
      return;
    }
    if (!player || msg.type !== "flap") return;
    const run = player.run;
    if (msg.version !== run.version) {
      send(socket, {
        type: "conflict",
        message: "Этот ход уже изменился в другом окне. Попробуйте снова.",
      });
      return;
    }
    if (Date.now() - lastFlap < 90) return;
    lastFlap = Date.now();
    if (run.phase === "over") Object.assign(run, { ...newRun(), version: run.version });
    run.phase = "flying";
    run.vy = -245;
    run.version++;
    socket.checkpoint = { run: { ...run }, best: player.best };
    dirty = true;
    broadcast();
  });
  socket.on("close", (code) => {
    clearTimeout(deadline);
    if (!player) return;
    const sockets = active.get(player);
    sockets.delete(socket);
    if (sockets.size === 0) {
      active.delete(player);
      const checkpoint = socket.checkpoint;
      if (
        code === 1006 &&
        checkpoint.run.phase === "flying" &&
        checkpoint.run.version === player.run.version
      ) {
        player.run = { ...checkpoint.run };
        player.best = checkpoint.best;
      }
      if (player.run.phase === "flying") player.run.phase = "paused";
      dirty = true;
      void save();
    }
  });
});

const physics = setInterval(() => {
  for (const player of active.keys()) {
    if (player.run.phase !== "flying") continue;
    advance(player.run);
    player.best = Math.max(player.best, player.run.points);
    dirty = true;
  }
}, STEP * 1000);
const sync = setInterval(() => {
  if (active.size) broadcast();
}, 45);
const checkpoint = setInterval(save, 500);
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate();
    else {
      ws.alive = false;
      if (ws.player) ws.pingState = { run: { ...ws.player.run }, best: ws.player.best };
      ws.ping();
    }
  }
}, 650);

async function stop() {
  clearInterval(physics);
  clearInterval(sync);
  clearInterval(checkpoint);
  clearInterval(heartbeat);
  for (const p of active.keys()) if (p.run.phase === "flying") p.run.phase = "paused";
  dirty = true;
  await writing;
  await save();
  for (const socket of wss.clients) socket.terminate();
  server.close(() => process.exit(0));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
server.listen(Number(process.env.PORT ?? 3104), process.env.HOST || "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "started", port: server.address().port }));
});
