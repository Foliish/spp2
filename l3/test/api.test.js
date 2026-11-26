import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { SMTPServer } from "smtp-server";

const adminEmail = "admin@example.org";
const editorEmail = "editor@example.org";
const emails = new Map();
const smtp = new SMTPServer({
  disabledCommands: ["STARTTLS"],
  onAuth(auth, session, done) {
    if (auth.username !== adminEmail || auth.password !== "test-smtp")
      return done(new Error("Invalid SMTP credentials"));
    done(null, { user: adminEmail });
  },
  onData(stream, session, done) {
    let message = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      message += chunk;
    });
    stream.on("end", () => {
      emails.set(session.envelope.rcptTo[0].address, message);
      done();
    });
  },
});

let app;
let child;
before(async () => {
  smtp.listen(0, "127.0.0.1");
  await once(smtp.server, "listening");
  child = spawn(process.execPath, ["server.js"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      DATA_DIR: "/tmp/spp-test",
      ADMIN_EMAIL: "",
      DEMO_EDITOR_EMAIL: editorEmail,
      MAIL_FROM: "",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtp.server.address().port),
      SMTP_REQUIRE_TLS: "0",
      SMTP_USER: adminEmail,
      SMTP_PASSWORD: "test-smtp",
    },
  });
  const logs = createInterface({ input: child.stdout });
  app = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Сервер не запустился")), 10000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Сервер завершился: " + code));
    });
    logs.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.event === "started") {
        clearTimeout(timer);
        resolve("http://127.0.0.1:" + event.port);
      }
    });
  });
});

after(async () => {
  if (child?.exitCode === null) {
    const exit = once(child, "exit");
    child.kill();
    await exit;
  }
  await new Promise((resolve) => smtp.close(resolve));
});

async function request(path, method = "GET", data, token) {
  const response = await fetch(app + path, {
    method,
    headers: {
      ...(data && !(data instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data instanceof FormData ? data : JSON.stringify(data),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: response.status === 204 ? null : await response.json(),
  };
}

async function requestCode(email) {
  const sent = await request("/api/auth/code", "POST", { email });
  assert.equal(sent.status, 202);
  const message = emails.get(email);
  assert.ok(message, "SMTP-сервер должен получить письмо");
  assert.match(message, /<admin@example\.org>/);
  const body = message.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  const text = message.includes("Content-Transfer-Encoding: base64")
    ? Buffer.from(body, "base64").toString("utf8")
    : body.replace(/=\r\n/g, "");
  const code = text.match(/: (\d{6})\b/)?.[1];
  assert.ok(code, "Письмо должно содержать код");
  return code;
}

async function login(email) {
  const result = await request("/api/auth/login", "POST", {
    email,
    code: await requestCode(email),
  });
  assert.equal(result.status, 200);
  return result.body;
}

test("почта, одноразовый код, роли, сессии и ограничение попыток", async () => {
  const email = randomUUID() + "@example.org";
  const admin = await login(adminEmail);
  assert.equal(admin.user.role, "admin");

  const first = await requestCode(email);
  let code = await requestCode(email);
  if (code === first) code = await requestCode(email);
  assert.notEqual(code, first);
  assert.equal((await request("/api/auth/login", "POST", { email, code: first })).status, 401);

  const results = await Promise.all(
    Array.from({ length: 2 }, () =>
      request("/api/auth/login", "POST", { email, code, role: "admin" }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
  const { user, token } = results.find((result) => result.status === 200).body;
  assert.equal(user.role, "reader");
  assert.equal((await request("/api/quotes", "GET", undefined, token)).status, 200);
  assert.equal(
    (await request("/api/quotes", "POST", { text: "Новая", author: "А", category: "Б" }, token))
      .status,
    403,
  );
  assert.equal((await request("/api/users", "GET", undefined, token)).status, 403);

  const changed = await request("/api/users/" + user.id, "PUT", { role: "editor" }, admin.token);
  assert.equal(changed.body.role, "editor");
  assert.equal((await request("/api/auth/me", "GET", undefined, token)).body.role, "editor");

  const second = await login(email);
  assert.equal(second.user.id, user.id);
  const current = await request("/api/auth/me", "GET", undefined, second.token);
  const sessionPath = "/api/auth/sessions/" + current.body.session_id;
  assert.equal((await request(sessionPath, "DELETE", undefined, admin.token)).status, 404);
  assert.equal((await request(sessionPath, "DELETE", undefined, token)).status, 204);
  assert.equal((await request("/api/auth/me", "GET", undefined, second.token)).status, 401);
  assert.equal((await request("/api/auth/logout", "POST", undefined, token)).status, 204);

  const limited = randomUUID() + "@example.org";
  const tries = await Promise.all(
    Array.from({ length: 6 }, () =>
      request("/api/auth/login", "POST", { email: limited, code: "000000" }),
    ),
  );
  assert.equal(tries.filter((result) => result.status === 401).length, 5);
  const blocked = tries.find((result) => result.status === 429);
  assert.equal(blocked?.headers.get("retry-after"), "900");
});

test("создание, поиск, версия, изображение и удаление цитаты", async () => {
  const { token, user } = await login(editorEmail);
  assert.equal(user.role, "editor");
  const data = { text: "Цитата " + randomUUID(), author: "А", category: "Б" };
  const created = await request("/api/quotes", "POST", data, token);
  assert.equal(created.status, 201);
  const path = created.headers.get("location");
  try {
    const found = await request(
      "/api/quotes?q=" + encodeURIComponent(data.text),
      "GET",
      undefined,
      token,
    );
    assert.deepEqual(
      found.body.map((quote) => quote.id),
      [created.body.id],
    );
    const edit = { ...data, text: "Правка", version: created.body.version };
    assert.equal((await request(path, "PUT", edit, token)).status, 200);
    assert.equal((await request(path, "PUT", edit, token)).status, 409);
    const image = new FormData();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO95l9sAAAAASUVORK5CYII=",
      "base64",
    );
    image.append("image", new Blob([png], { type: "image/png" }), "sample.png");
    const uploaded = await request(path + "/image", "POST", image, token);
    assert.equal(uploaded.status, 200);
    assert.equal((await fetch(app + uploaded.body.image)).status, 200);
    assert.equal((await request(path + "/image", "DELETE", undefined, token)).body.image, null);
    assert.equal((await fetch(app + uploaded.body.image)).status, 404);
  } finally {
    assert.equal((await request(path, "DELETE", undefined, token)).status, 204);
    assert.equal((await request(path, "GET", undefined, token)).status, 404);
  }
});
