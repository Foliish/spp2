import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { db, prepareDatabase } from "./db.js";
import { accounts, auth, clearExpired, prepareAuth } from "./auth.js";
import { quotes, readImage } from "./quotes.js";
import { allow, HttpError } from "./http.js";

await prepareDatabase();
await prepareAuth();
await clearExpired();
setInterval(() => {
  clearExpired().catch(error => console.error(JSON.stringify({ event: "cleanup", code: error.code })));
}, 60000).unref();

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.use((req, res, next) => {
  const requestId = randomUUID();
  const start = performance.now();
  res.set({
    "X-Request-Id": requestId,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  });
  res.once("finish", () => console.log(JSON.stringify({
    event: "request",
    time: new Date().toISOString(),
    requestId,
    method: req.method,
    path: req.originalUrl.split("?")[0],
    status: res.statusCode,
    durationMs: Math.round(performance.now() - start),
  })));
  next();
});

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, express.json({ limit: "32kb" }));

app.route("/api/health").get(async (req, res) => {
  await db.query("SELECT 1");
  res.json({ status: "ok" });
}).all(allow("GET", "HEAD"));

app.use("/api/auth", auth);
app.use("/api/users", accounts);
app.use("/api/quotes", quotes);
app.route("/uploads/:key").get(readImage).all(allow("GET", "HEAD"));
app.use(express.static(fileURLToPath(new URL("./public/", import.meta.url))));
app.use(() => { throw new HttpError(404, "Ресурс не найден"); });

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) return res.set(error.headers).status(error.status).json({ error: error.message });
  if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Некорректный JSON" });
  if (error.type === "entity.too.large") return res.status(413).json({ error: "Слишком большой запрос" });
  console.error(JSON.stringify({ event: "error", requestId: res.get("X-Request-Id"), code: error.code }));
  res.status(500).json({ error: "Ошибка сервера" });
});

const server = app.listen(Number(process.env.PORT ?? 3103), process.env.HOST || "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "started", port: server.address().port }));
});
