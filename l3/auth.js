import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { Router } from "express";
import nodemailer from "nodemailer";
import { db, transaction } from "./db.js";
import { allow, HttpError, jsonBody, positiveId, unauthorized } from "./http.js";

const ranks = { reader: 0, editor: 1, admin: 2 };
const secret = process.env.CODE_SECRET || randomBytes(32);
const tokenHash = token => createHash("sha256").update(token).digest("hex");
const digest = (email, code) => createHmac("sha256", secret).update(email + ":" + code).digest("hex");
const permittedEmails = (process.env.DEMO_EMAILS || "").split(",").filter(Boolean);
let mailer;
let sender;

function emailAddress(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 120 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9]{2,}$/.test(email)) {
    throw new HttpError(422, "Некорректный email");
  }
  return email;
}

export async function prepareAuth() {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD?.trim();
  if (!user || !pass) throw new Error("Задайте SMTP_USER и SMTP_PASSWORD");
  sender = emailAddress(process.env.MAIL_FROM || user);
  const admin = emailAddress(process.env.ADMIN_EMAIL || user);
  const port = Number(process.env.SMTP_PORT || 465);
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    requireTLS: process.env.SMTP_REQUIRE_TLS !== "0",
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  await db.query(`
    INSERT INTO users (email, role) VALUES ($1, 'admin')
    ON CONFLICT (email) DO UPDATE SET role = 'admin'
  `, [admin]);
}

export function requireRole(role) {
  return async (req, res, next) => {
    const token = req.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    if (!token) throw unauthorized();
    const { rows: [user] } = await db.query(`
      UPDATE sessions s SET last_seen = now()
      FROM users u
      WHERE s.user_id = u.id AND s.token_hash = $1 AND s.expires_at > now()
      RETURNING u.id, u.email, u.role, s.id AS session_id
    `, [tokenHash(token)]);
    if (!user) throw unauthorized("Сессия истекла или завершена");
    if (ranks[user.role] < ranks[role]) throw new HttpError(403, "Недостаточно прав");
    req.user = user;
    next();
  };
}

async function limit(bucket, maximum) {
  const { rowCount } = await db.query(`
    INSERT INTO attempts (bucket) VALUES ($1)
    ON CONFLICT (bucket) DO UPDATE
    SET hits = CASE WHEN attempts.since < now() - interval '15 minutes' THEN 1 ELSE attempts.hits + 1 END,
        since = CASE WHEN attempts.since < now() - interval '15 minutes' THEN now() ELSE attempts.since END
    WHERE attempts.since < now() - interval '15 minutes' OR attempts.hits < $2
    RETURNING hits
  `, [bucket, maximum]);
  if (!rowCount) throw new HttpError(429, "Слишком много попыток. Повторите через 15 минут", { "Retry-After": "900" });
}

export async function clearExpired() {
  await db.query(`
    DELETE FROM sessions WHERE expires_at <= now();
    DELETE FROM login_codes WHERE expires_at <= now();
    DELETE FROM attempts WHERE since < now() - interval '15 minutes';
  `);
}

export const auth = Router();
export const accounts = Router();

auth.route("/code").post(async (req, res) => {
  const email = emailAddress(jsonBody(req).email);
  if (permittedEmails.length && !permittedEmails.includes(email)) {
    throw new HttpError(422, "Учебные адреса: " + permittedEmails.join(", "));
  }
  await limit("send-ip:" + req.ip, 20);
  await limit("send-email:" + email, 5);
  const code = String(randomInt(1000000)).padStart(6, "0");
  const hash = digest(email, code);
  await db.query(`
    INSERT INTO login_codes (email, digest, expires_at) VALUES ($1, $2, now() + interval '10 minutes')
    ON CONFLICT (email) DO UPDATE SET digest = excluded.digest, expires_at = excluded.expires_at
  `, [email, hash]);
  try {
    await mailer.sendMail({
      from: { name: "Собрание цитат", address: sender },
      to: { name: "", address: email },
      subject: "Код входа",
      text: "Код входа: " + code + "\nКод действует 10 минут.",
    });
  } catch (error) {
    await db.query("DELETE FROM login_codes WHERE email = $1 AND digest = $2", [email, hash]);
    console.error(JSON.stringify({ event: "smtp", requestId: res.get("X-Request-Id"), code: error.code }));
    throw new HttpError(503, "Письмо не отправлено. Попробуйте позже");
  }
  res.status(202).json({ message: "Код отправлен на почту" });
}).all(allow("POST"));

auth.route("/login").post(async (req, res) => {
  const body = jsonBody(req);
  const email = emailAddress(body.email);
  const key = "login-email:" + email;
  await limit("login-ip:" + req.ip, 40);
  await limit(key, 5);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) throw new HttpError(422, "Введите шесть цифр");
  const token = randomBytes(32).toString("hex");
  const user = await transaction(async connection => {
    const used = await connection.query(`
      DELETE FROM login_codes WHERE email = $1 AND digest = $2 AND expires_at > now()
    `, [email, digest(email, code)]);
    if (!used.rowCount) throw unauthorized("Неверный или просроченный код");
    await connection.query("INSERT INTO users (email, role) VALUES ($1, 'reader') ON CONFLICT (email) DO NOTHING", [email]);
    const { rows: [account] } = await connection.query("SELECT id, email, role FROM users WHERE email = $1", [email]);
    const { rows: [session] } = await connection.query(`
      INSERT INTO sessions (user_id, token_hash, expires_at, ip, agent)
      VALUES ($1, $2, now() + interval '2 hours', $3, $4) RETURNING id
    `, [account.id, tokenHash(token), req.ip, (req.get("User-Agent") || "").slice(0, 300)]);
    await connection.query("DELETE FROM attempts WHERE bucket = $1", [key]);
    return { ...account, session_id: session.id };
  });
  res.json({ token, expiresIn: 7200, user });
}).all(allow("POST"));

auth.route("/me").get(requireRole("reader"), (req, res) => res.json(req.user)).all(allow("GET", "HEAD"));

auth.route("/logout").post(requireRole("reader"), async (req, res) => {
  await db.query("DELETE FROM sessions WHERE id = $1", [req.user.session_id]);
  res.sendStatus(204);
}).all(allow("POST"));

auth.route("/sessions").get(requireRole("reader"), async (req, res) => {
  const { rows } = await db.query(`
    SELECT id, expires_at, last_seen, ip, agent FROM sessions
    WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen DESC
  `, [req.user.id]);
  res.json(rows);
}).all(allow("GET", "HEAD"));

auth.route("/sessions/:id").delete(requireRole("reader"), async (req, res) => {
  const result = await db.query("DELETE FROM sessions WHERE id = $1 AND user_id = $2", [positiveId(req.params.id), req.user.id]);
  if (!result.rowCount) throw new HttpError(404, "Сессия не найдена");
  res.sendStatus(204);
}).all(allow("DELETE"));

accounts.route("/").get(requireRole("admin"), async (req, res) => {
  const { rows } = await db.query("SELECT id, email, role FROM users ORDER BY id");
  res.json(rows);
}).all(allow("GET", "HEAD"));

accounts.route("/:id").put(requireRole("admin"), async (req, res) => {
  const id = positiveId(req.params.id);
  const { role } = jsonBody(req);
  if (typeof role !== "string" || !Object.hasOwn(ranks, role)) throw new HttpError(422, "Неизвестная роль");
  if (id === req.user.id && role !== "admin") throw new HttpError(409, "Нельзя снять собственные права");
  const { rows: [user] } = await db.query("UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role", [role, id]);
  if (!user) throw new HttpError(404, "Пользователь не найден");
  res.json(user);
}).all(allow("PUT"));
