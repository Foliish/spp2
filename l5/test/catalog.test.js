import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";

async function child(file, env) {
  const proc = spawn(process.execPath, [file], {
    env: { ...process.env, HOST: "127.0.0.1", ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const logs = [];
  const lines = createInterface({ input: proc.stdout });
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(file + " startup timeout")), 15_000);
      proc.once("exit", code => { clearTimeout(timer); reject(Error(file + " exited: " + code)); });
      lines.on("line", line => {
        try {
          const entry = JSON.parse(line);
          logs.push(entry);
          if (entry.event === "started") { clearTimeout(timer); resolve(entry.port); }
        } catch {}
      });
    });
  } catch (error) {
    proc.kill();
    throw error;
  }
  return { url: "http://127.0.0.1:" + port, logs, async stop() {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const closed = once(proc, "exit");
    proc.kill();
    await closed;
  } };
}

test("реальные источники, GraphQL, отказ подграфа и сохранённый снимок", { timeout: 100_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "spp-catalog-"));
  const services = [];
  const launch = async (file, env) => {
    const service = await child(file, { DATA_DIR: dir, TRACE_LOG: "1", ...env });
    services.push(service);
    return service;
  };
  const offline = createServer((_, res) => res.writeHead(503).end());
  try {
    const ids = ["MOVIELENS", "TVMAZE", "DATASF"];
    for (const id of ids) {
      await cp(join("data", id + ".json"), join(dir, id + ".json")).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const catalog = await launch("catalog.js");
    const collection = await launch("collection.js");
    const gateway = await launch("server.js", { CATALOG_URL: catalog.url + "/graphql",
      COLLECTION_URL: collection.url + "/graphql", RATE_LIMIT: "22" });
    async function graph(query, variables, via = gateway.url, owner = "a".repeat(48)) {
      const response = await fetch(via + "/graphql", { method: "POST", signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/json", "x-collection": owner },
        body: JSON.stringify({ query, variables }) });
      return { status: response.status, trace: response.headers.get("x-trace-id"), ...await response.json() };
    }
    const status = "{ catalog { count sources { id count updatedAt error } } }";
    let sourceStatus;
    for (let i = 0; i < 37; i++) {
      sourceStatus = (await graph(status, {}, catalog.url)).data.catalog;
      if (sourceStatus.sources.every(s => s.count > 0)) break;
      await wait(1800);
    }
    assert.ok(sourceStatus.count >= 10_000);
    assert.deepEqual(sourceStatus.sources.map(s => s.id), ids);
    assert.ok(sourceStatus.sources.every(s => s.count > 0));
    const q = `query Browse($page:Int!){entries(filter:{ source:MOVIELENS, kind:MOVIE, text:"transporter" },
      order:NEWEST,page:$page,size:1){total items{id title year source{publisher{name url}}}}}`;
    const one = await graph(q, { page: 1 });
    const two = await graph(q, { page: 2 });
    assert.equal(one.status, 200);
    assert.ok(one.data.entries.total >= 3);
    const [first, second] = [one, two].map(r => r.data.entries.items[0]);
    assert.match(first.title, /transporter/i);
    assert.ok(first.year >= second.year);
    assert.notEqual(first.id, second.id);
    assert.equal(first.source.publisher.name, "GroupLens Research");
    const mut = "mutation Fav($id:ID!){setSaved(id:$id,save:true){savedByMe title}}";
    const saved = await graph(mut, { id: first.id });
    assert.equal(saved.data.setSaved.savedByMe, true);
    assert.equal(saved.data.setSaved.title, first.title);
    const favorites = "{ savedEntries { id title savedByMe } }";
    assert.deepEqual((await graph(favorites)).data.savedEntries.map(x => x.id), [first.id]);
    assert.deepEqual((await graph(favorites, {}, gateway.url, "b".repeat(48))).data.savedEntries, []);
    await wait(100);
    assert.equal(saved.trace, saved.extensions.traceId);
    for (const log of [gateway, collection, catalog]) assert.ok(log.logs.some(line => line.traceId === saved.trace), log.url);
    assert.match(await (await fetch(gateway.url + "/metrics")).text(), /spp_graphql_duration_ms_count [1-9]/);

    const excessive = await graph("{ " + Array.from({ length: 8 }, (_, i) => `a${i}: entries { total }`).join(" ") + " }");
    assert.equal(excessive.status, 400);
    await collection.stop();
    const partial = await graph("{ entries(size:1){items{id title savedByMe}} }");
    assert.ok(partial.errors?.length);
    assert.ok(partial.data.entries.items[0].title);
    assert.equal(partial.data.entries.items[0].savedByMe, null);
    assert.ok((await graph("{ entries(size:1){items{id title}} }")).data.entries.items[0].title);
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) limited = (await graph(status)).status === 429;
    assert.ok(limited);

    await catalog.stop();
    offline.listen(0, "127.0.0.1");
    await once(offline, "listening");
    const file = join(dir, "DATASF.json");
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    snapshot.updatedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(file, JSON.stringify(snapshot));
    const restored = await launch("catalog.js", { DATASF_URL: `http://127.0.0.1:${offline.address().port}` });
    for (let i = 0; i < 10; i++) {
      const current = (await graph(status, {}, restored.url)).data.catalog;
      assert.equal(current.count, sourceStatus.count);
      if (current.sources.find(s => s.id === "DATASF").error) return;
      await wait(650);
    }
    assert.fail("Источник должен показать ошибку при сохранённых данных");
  } finally {
    if (offline.listening) offline.close();
    await Promise.all(services.map(p => p.stop()));
    await rm(dir, { recursive: true, force: true });
  }
});
