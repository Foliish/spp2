import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";

const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  children.forEach(child => child.kill());
  process.exitCode = code;
}
function run(file, env) {
  const child = spawn(process.execPath, [file], { stdio: "inherit", env: { ...process.env, ...env } });
  children.push(child);
  child.once("exit", () => stop(1));
  child.once("error", error => { console.error(error); stop(1); });
  return child;
}
process.once("SIGTERM", () => stop(0));
process.once("SIGINT", () => stop(0));
async function ready(port) {
  const until = Date.now() + 20_000;
  while (Date.now() < until && !stopping) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/health", { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch {}
    await wait(150);
  }
  throw new Error("Сервис не запустился на порту " + port);
}
const catalog = process.env.CATALOG_PORT || "3115";
const collection = process.env.COLLECTION_PORT || "3116";
try {
  run("catalog.js", { PORT: catalog, HOST: "127.0.0.1" });
  run("collection.js", { PORT: collection, HOST: "127.0.0.1" });
  await Promise.all([ready(catalog), ready(collection)]);
  await once(run("server.js", { CATALOG_URL: `http://127.0.0.1:${catalog}/graphql`,
    COLLECTION_URL: `http://127.0.0.1:${collection}/graphql` }), "exit");
} catch (error) {
  if (!stopping) console.error(error.message);
  stop(1);
}
