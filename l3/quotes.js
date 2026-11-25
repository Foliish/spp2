import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { db } from "./db.js";
import { requireRole } from "./auth.js";
import { allow, HttpError, jsonBody, positiveId } from "./http.js";

export const quotes = Router();
const columns = "id, text, author, category, version, created_at, '/uploads/' || image_key AS image";
const read = requireRole("reader");
const edit = requireRole("editor");
const parseImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
}).single("image");

function fields(body) {
  return [["text", 2000], ["author", 100], ["category", 60]].map(([name, max]) => {
    const value = typeof body[name] === "string" ? body[name].trim() : "";
    if (!value || value.length > max) throw new HttpError(422, "Проверьте текст, автора и категорию");
    return value;
  });
}

function requireMultipart(req, res, next) {
  if (!req.is("multipart/form-data")) throw new HttpError(415, "Ожидается multipart/form-data");
  parseImage(req, res, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "Изображение больше 2 МБ"));
    const status = error instanceof multer.MulterError ? 422 : 400;
    next(new HttpError(status, "Загрузите одно изображение в поле image"));
  });
}

function validImage(file) {
  if (!file) return false;
  const { mimetype: type, buffer } = file;
  if (type === "image/png") return buffer.toString("hex", 0, 8) === "89504e470d0a1a0a";
  if (type === "image/jpeg") return buffer.toString("hex", 0, 3) === "ffd8ff";
  return type === "image/webp" && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

async function quoteById(value) {
  const id = positiveId(value);
  const { rows: [quote] } = await db.query("SELECT " + columns + " FROM quotes WHERE id = $1", [id]);
  if (!quote) throw new HttpError(404, "Цитата не найдена");
  return quote;
}

async function changedQuote(sql, values) {
  const { rows: [updated] } = await db.query(sql + " RETURNING " + columns, values);
  if (!updated) throw new HttpError(409, "Цитата уже изменилась. Обновите список");
  return updated;
}

quotes.route("/").get(read, async (req, res) => {
  const term = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (term.length > 200) throw new HttpError(422, "Поисковый запрос слишком длинный");
  const { rows } = await db.query(`
    SELECT ${columns} FROM quotes
    WHERE strpos(lower(text), lower($1)) > 0 OR strpos(lower(author), lower($1)) > 0
    ORDER BY id DESC
  `, [term]);
  res.json(rows);
}).post(edit, async (req, res) => {
  const { rows: [quote] } = await db.query(`
    INSERT INTO quotes (text, author, category) VALUES ($1, $2, $3) RETURNING ${columns}
  `, fields(jsonBody(req)));
  res.location("/api/quotes/" + quote.id).status(201).json(quote);
}).all(allow("GET", "HEAD", "POST"));

quotes.route("/:id").get(read, async (req, res) => {
  res.json(await quoteById(req.params.id));
}).put(edit, async (req, res) => {
  const data = jsonBody(req);
  const quote = await quoteById(req.params.id);
  const version = data.version === undefined ? quote.version : data.version;
  if (!Number.isInteger(version) || version < 1 || version > 2147483647) {
    throw new HttpError(422, "Некорректная версия");
  }
  res.json(await changedQuote(`
    UPDATE quotes SET text = $1, author = $2, category = $3, version = version + 1
    WHERE id = $4 AND version = $5
  `, [...fields(data), quote.id, version]));
}).delete(edit, async (req, res) => {
  const result = await db.query("DELETE FROM quotes WHERE id = $1", [positiveId(req.params.id)]);
  if (!result.rowCount) throw new HttpError(404, "Цитата не найдена");
  res.sendStatus(204);
}).all(allow("GET", "HEAD", "PUT", "DELETE"));

quotes.route("/:id/image").post(edit, requireMultipart, async (req, res) => {
  if (!validImage(req.file)) throw new HttpError(422, "Нужно изображение PNG, JPEG или WebP");
  const { id, version } = await quoteById(req.params.id);
  res.json(await changedQuote(`
    UPDATE quotes SET image_key = $1, image_type = $2, image_bytes = $3, version = version + 1
    WHERE id = $4 AND version = $5
  `, [randomUUID(), req.file.mimetype, req.file.buffer, id, version]));
}).delete(edit, async (req, res) => {
  const { id, version } = await quoteById(req.params.id);
  res.json(await changedQuote(`
    UPDATE quotes SET image_key = NULL, image_type = NULL, image_bytes = NULL, version = version + 1
    WHERE id = $1 AND version = $2
  `, [id, version]));
}).all(allow("POST", "DELETE"));

export async function readImage(req, res) {
  const key = req.params.key;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) throw new HttpError(404, "Изображение не найдено");
  const { rows: [image] } = await db.query("SELECT image_type, image_bytes FROM quotes WHERE image_key = $1", [key]);
  if (!image) throw new HttpError(404, "Изображение не найдено");
  res.set("Cache-Control", "no-cache").type(image.image_type).send(image.image_bytes);
}
