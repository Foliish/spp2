import { Router } from "express";
import multer from "multer";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { query, dataDir } from "./db.js";
import { HttpError, quoteFields, methodNotAllowed } from "./validation.js";

export const quotesRouter = Router();
await mkdir(dataDir + "/uploads", { recursive: true });
const imageTypes = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter(req, file, next) {
    if (!Object.hasOwn(imageTypes, file.mimetype))
      return next(new HttpError(422, "Нужен PNG, JPEG или WebP"));
    next(null, true);
  },
}).single("image");

quotesRouter.param("id", async (req, res, next, value) => {
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new HttpError(400, "Некорректный идентификатор");
  req.quote = (await query("SELECT * FROM quotes WHERE id=$1", [Number(value)])).rows[0];
  if (!req.quote) throw new HttpError(404, "Цитата не найдена");
  next();
});

quotesRouter.route("/")
  .get(async (req, res) => {
    const result = await query("SELECT * FROM quotes ORDER BY id DESC");
    res.json(result.rows);
  })
  .post(async (req, res) => {
    const result = await query(
      "INSERT INTO quotes(text,author,category) VALUES ($1,$2,$3) RETURNING *",
      quoteFields(req),
    );
    const quote = result.rows[0];
    res.location("/api/quotes/" + quote.id).status(201).json(quote);
  })
  .all(methodNotAllowed("GET", "POST"));

quotesRouter.route("/:id")
  .get((req, res) => res.json(req.quote))
  .put(async (req, res) => {
    const values = quoteFields(req);
    const result = await query(
      "UPDATE quotes SET text=$1,author=$2,category=$3 WHERE id=$4 RETURNING *",
      [...values, req.quote.id],
    );
    if (!result.rows.length) throw new HttpError(404, "Цитата не найдена");
    res.json(result.rows[0]);
  })
  .delete(async (req, res) => {
    await query("DELETE FROM quotes WHERE id=$1", [req.quote.id]);
    await removeImage(req.quote.image);
    res.sendStatus(204);
  })
  .all(methodNotAllowed("GET", "PUT", "DELETE"));

quotesRouter.route("/:id/image")
  .post((req, res, next) => {
    if (!req.is("multipart/form-data")) throw new HttpError(415, "Ожидается multipart/form-data");
    upload(req, res, (error) => {
      if (error && !(error instanceof multer.MulterError) && !(error instanceof HttpError))
        error = new HttpError(400, "Некорректный multipart");
      next(error);
    });
  }, async (req, res) => {
    const file = req.file;
    if (!file?.buffer.length) throw new HttpError(422, "Выберите изображение");
    if (!isImage(file.buffer, file.mimetype))
      throw new HttpError(422, "Содержимое файла не соответствует изображению");
    const image = "/uploads/" + randomUUID() + imageTypes[file.mimetype];
    await writeFile(dataDir + image, file.buffer);
    try {
      res.json(await updateImage(req.quote, image));
    } catch (error) {
      await removeImage(image);
      throw error;
    }
  })
  .delete(async (req, res) => res.json(await updateImage(req.quote, null)))
  .all(methodNotAllowed("POST", "DELETE"));

function isImage(buffer, mime) {
  if (mime === "image/png")
    return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

async function updateImage(quote, image) {
  const result = await query(
    "UPDATE quotes SET image=$1 WHERE id=$2 RETURNING *",
    [image, quote.id],
  );
  if (!result.rows.length) throw new HttpError(404, "Цитата не найдена");
  await removeImage(quote.image);
  return result.rows[0];
}

async function removeImage(image) {
  if (image) await unlink(dataDir + image).catch(() => {});
}
