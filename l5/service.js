import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { ApolloServer, HeaderMap } from "@apollo/server";
import { getOperationAST, Kind, parse } from "graphql";

const buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];
const hex = length => randomBytes(length).toString("hex");
const format = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
const fail = (res, status, message) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ errors: [{ message }] }));
};

function checkDocument(query, operationName) {
  const ast = parse(query, { maxTokens: 1400 });
  const operation = getOperationAST(ast, operationName);
  if (!operation) throw new Error("Укажите одну операцию или её имя");
  const fragments = new Map(ast.definitions.filter(x => x.kind === Kind.FRAGMENT_DEFINITION).map(x => [x.name.value, x]));
  let weight = 0;
  function walk(selection, depth) {
    if (depth > 9) throw new Error("Допустимая глубина запроса — 9");
    for (const node of selection.selections) {
      const field = node.name?.value;
      weight += ["entries", "savedEntries"].includes(field) ? 25 : 1;
      if (weight > 110) throw new Error("Запрос слишком сложный");
      const child = node.kind === Kind.FRAGMENT_SPREAD ? fragments.get(field)?.selectionSet : node.selectionSet;
      if (child) walk(child, depth + 1);
    }
  }
  walk(operation.selectionSet, 1);
}

export async function listen({ name, port, schema, gateway, publicSite = false }) {
  const stats = { total: 0, errors: 0, limited: 0, active: 0, sum: 0, bins: buckets.map(() => 0) };
  const apollo = new ApolloServer({
    ...(gateway ? { gateway } : { schema }),
    stopOnTerminationSignals: false,
    includeStacktraceInErrorResponses: false,
    plugins: [{ async requestDidStart() {
      return {
        async didEncounterErrors() { stats.errors++; },
        async willSendResponse({ response, contextValue }) {
          if (publicSite && response.body.kind === "single") {
            response.body.singleResult.extensions = { ...response.body.singleResult.extensions,
              traceId: contextValue.traceId, durationMs: Math.round(performance.now() - contextValue.start) };
          }
        },
      };
    } }],
  });
  await apollo.start();

  const assets = new Map();
  if (publicSite) {
    for (const [path, [filename, type]] of Object.entries(format)) {
      assets.set(path, [await readFile(new URL("./public/" + filename, import.meta.url)), type]);
    }
  }
  const rates = new Map();
  let windowStart = Date.now(), requests = 0;
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 8000 }, async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/health" && req.method === "GET") return res.end("ok");
    if (path === "/metrics" && req.method === "GET") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      return res.end([
        "# TYPE spp_graphql_requests_total counter",
        `spp_graphql_requests_total ${stats.total}`,
        `spp_graphql_errors_total ${stats.errors}`, `spp_graphql_limited_total ${stats.limited}`,
        `spp_graphql_active ${stats.active}`,
        "# TYPE spp_graphql_duration_ms histogram",
        ...buckets.map((le, i) => `spp_graphql_duration_ms_bucket{le="${le}"} ${stats.bins[i]}`),
        `spp_graphql_duration_ms_bucket{le="+Inf"} ${stats.total}`,
        `spp_graphql_duration_ms_count ${stats.total}`, `spp_graphql_duration_ms_sum ${stats.sum}`, "",
      ].join("\n"));
    }
    const asset = req.method === "GET" && assets.get(path);
    if (asset) {
      res.setHeader("Content-Type", asset[1] + "; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-cache");
      return res.end(asset[0]);
    }
    if (path !== "/graphql") return fail(res, 404, "Ресурс не найден");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return fail(res, 405, "Используйте POST");
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return fail(res, 415, "Ожидается JSON");
    if (publicSite) {
      if (Date.now() - windowStart >= 60_000) { requests = 0; rates.clear(); windowStart = Date.now(); }
      const forwarded = cfgProxy() ? req.headers["x-forwarded-for"]?.split(",").at(-1)?.trim() : null;
      const ip = forwarded || req.socket.remoteAddress;
      const used = rates.get(ip) || 0;
      if (used >= Number(process.env.RATE_LIMIT || 240) || requests >= 3500 || stats.active >= 32) {
        stats.limited++;
        res.setHeader("Retry-After", stats.active >= 32 ? "1" : String(Math.ceil((60_000 - (Date.now() - windowStart)) / 1000)));
        req.resume();
        return fail(res, 429, "Лимит запросов. Повторите позже.");
      }
      rates.set(ip, used + 1);
      requests++;
    }
    const start = performance.now();
    const traceId = !publicSite && /^[a-f0-9]{32}$/.test(req.headers["x-trace-id"]) ? req.headers["x-trace-id"] : hex(16);
    const parent = !publicSite && /^[a-f0-9]{16}$/.test(req.headers["x-parent-span"]) ? req.headers["x-parent-span"] : undefined;
    const span = hex(8);
    res.setHeader("X-Trace-Id", traceId);
    stats.active++;
    let operation;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 64_000) {
          req.resume();
          return fail(res, 413, "Слишком большое тело запроса");
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body.query !== "string") throw new Error("Ожидается строка query");
        if (publicSite) checkDocument(body.query, body.operationName);
      } catch (error) {
        return fail(res, 400, error.message);
      }
      operation = typeof body.operationName === "string" ? body.operationName : undefined;
      const headers = new HeaderMap(Object.entries(req.headers).map(([key, value]) => [key, String(value)]));
      const requestedOwner = req.headers["x-collection"];
      const owner = /^[a-f0-9]{48}$/.test(requestedOwner) ? requestedOwner : null;
      const result = await apollo.executeHTTPGraphQLRequest({
        httpGraphQLRequest: { method: "POST", search: "", headers, body },
        context: async () => ({ traceId, span, owner, start }),
      });
      res.writeHead(result.status || 200, Object.fromEntries(result.headers));
      if (result.body.kind === "complete") res.end(result.body.string);
      else {
        for await (const chunk of result.body.asyncIterator) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        res.end();
      }
    } catch (error) {
      if (!res.headersSent) fail(res, 500, "Ошибка сервера");
      else res.destroy();
      console.error(JSON.stringify({ event: "error", name, traceId, message: error.message }));
    } finally {
      const ms = Math.round((performance.now() - start) * 10) / 10;
      stats.active--;
      stats.total++;
      stats.sum += ms;
      buckets.forEach((le, i) => { if (ms <= le) stats.bins[i]++; });
      if (process.env.TRACE_LOG !== "0") {
        console.log(JSON.stringify({ event: "graphql", name, traceId, span, parent, operation, status: res.statusCode, ms }));
      }
    }
  });
  server.listen(port, process.env.HOST || "127.0.0.1");
  await once(server, "listening");
  console.log(JSON.stringify({ event: "started", name, port: server.address().port }));
  return server;
}
function cfgProxy() { return process.env.TRUST_PROXY === "1"; }
