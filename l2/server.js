import express from "express";
import multer from "multer";
import { fileURLToPath } from "node:url";
import { dataDir } from "./db.js";
import { quotesRouter } from "./quotes.js";

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use("/api/quotes", quotesRouter);

app.use("/uploads", express.static(dataDir + "/uploads"));
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));
app.use((req, res) => res.status(404).json({ error: "Ресурс не найден" }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  let status = error.status || 500;
  let message = error.message;
  if (error instanceof multer.MulterError) {
    status = error.code === "LIMIT_FILE_SIZE" ? 413 : 422;
    message = status === 413 ? "Изображение больше 2 МБ" : "Нужно одно изображение в поле image";
  } else if (error.type === "entity.parse.failed") {
    message = "Некорректный JSON";
  } else if (error.type === "entity.too.large") {
    message = "Слишком большой запрос";
  } else if (status === 500) {
    message = "Ошибка сервера";
  }
  res.status(status).json({ error: message });
});

app.listen(Number(process.env.PORT || 3102), "0.0.0.0");
