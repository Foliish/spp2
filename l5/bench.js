import { performance } from "node:perf_hooks";

const url = process.env.GRAPHQL_URL || "http://localhost:3105/graphql";
const requests = 100, concurrency = 10;
const timings = [];
let failures = 0;
const started = performance.now();
const query = "query Bench($page:Int!) { entries(order:NEWEST,page:$page,size:15){ total items { id title source { name } } } }";
await Promise.all(Array.from({ length: concurrency }, (_, worker) => (async () => {
  for (let i = worker; i < requests; i += concurrency) {
    const start = performance.now();
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ query, operationName: "Bench", variables: { page: i % 10 + 1 } }),
      });
      const result = await response.json();
      if (!response.ok || result.errors || !result.data?.entries?.total) throw new Error("GraphQL response");
      timings.push(performance.now() - start);
    } catch { failures++; }
  }
})()));
timings.sort((a, b) => a - b);
const percentile = p => timings.length ? Number(timings[Math.ceil(timings.length * p) - 1].toFixed(1)) : null;
const seconds = (performance.now() - started) / 1000;
console.log(JSON.stringify({ requests, concurrency, failures, p50_ms: percentile(.5), p95_ms: percentile(.95),
  requests_per_second: Number((timings.length / seconds).toFixed(1)) }));
process.exitCode = failures ? 1 : 0;
