import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import { WebSocket } from "ws";
import { advance, gate, newRun, RADIUS, GATE_WIDTH } from "../game.js";

test("очки за ворота, столкновение с воротами и полом", () => {
  const run = { ...newRun(), x: gate(0).x + GATE_WIDTH + RADIUS - 1 };
  advance(run);
  assert.equal(run.points, 1);
  const blocked = { ...newRun(), x: gate(0).x, y: 50 };
  advance(blocked);
  assert.equal(blocked.phase, "over");
  const floor = { ...newRun(), y: 415, vy: 20 };
  advance(floor);
  assert.equal(floor.phase, "over");
});

async function launch(dir) {
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DATA_DIR: dir, ALLOWED_ORIGIN: "" },
  });
  child.stderr.pipe(process.stderr);
  const [line] = await once(child.stdout, "data", { signal: AbortSignal.timeout(8000) });
  const port = JSON.parse(line.toString()).port;
  return { port, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
  } };
}

async function connect(port, join) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/play`, { origin: `http://127.0.0.1:${port}` });
  const messages = [];
  socket.on("message", raw => messages.push(JSON.parse(raw)));
  await once(socket, "open", { signal: AbortSignal.timeout(5000) });
  function send(msg) { socket.send(JSON.stringify(msg)); }
  async function receive(test) {
    for (let tries = 0; tries < 160; tries++) {
      const index = messages.findIndex(test);
      if (index >= 0) return messages.splice(index, 1)[0];
      await wait(25);
    }
    throw new Error("WebSocket response didn't arrive");
  }
  send({ type: "join", ...join });
  const identity = await receive(m => m.type === "joined");
  const state = (check) => receive(m => m.type === "state" &&
    m.visible.some(p => p.id === identity.id && check(p, m)));
  return { ...identity, send, state, receive, async close(abrupt = false) {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, "close");
    if (abrupt) socket.terminate();
    else socket.close();
    await closed;
  } };
}

test("два игрока, конфликт одного профиля, пауза, восстановление после запуска", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spp-flight-"));
  let server = await launch(dir);
  const clients = [];
  const player = async join => {
    const client = await connect(server.port, join);
    clients.push(client);
    return client;
  };
  try {
    const a = await player({ name: "Алиса" });
    const b = await player({ name: "Борис" });
    await a.state((p, m) => m.visible.length === 2);
    b.send({ type: "flap", version: 0 });
    b.send({ type: "flap", version: 1 });
    await b.receive(m => m.type === "throttled");
    await b.state(p => p.version === 1);
    const secondTab = await player({ token: a.token });
    const { x } = (await a.state(p => p.phase === "ready")).visible.find(p => p.id === a.id);
    a.send({ type: "flap", version: 0 });
    await a.state(p => p.x > x && p.phase === "flying");
    secondTab.send({ type: "flap", version: 0 });
    await secondTab.receive(m => m.type === "conflict");
    await b.state((_, m) => m.visible.some(p => p.id === a.id && p.x > x));
    await secondTab.close();
    await a.close(true);
    await b.state((_, m) => m.visible.length === 1);
    const again = await player({ token: a.token });
    const paused = (await again.state(p => p.phase === "paused")).visible.find(p => p.id === a.id);
    assert.ok(paused.x >= x);
    assert.equal(paused.version, 1);
    await again.close();
    await b.close();
    await wait(650);
    await server.stop();
    server = await launch(dir);
    const restarted = await player({ token: a.token });
    const restored = (await restarted.state(p => p.phase === "paused")).visible.find(p => p.id === a.id);
    assert.deepEqual(restored, paused);
    restarted.send({ type: "flap", version: restored.version });
    await restarted.state(p => p.phase === "flying" && p.x > paused.x);
  } finally {
    await Promise.all(clients.map(c => c.close()));
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
