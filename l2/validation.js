export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function quoteFields(req) {
  if (!req.is("application/json")) throw new HttpError(415, "Ожидается application/json");
  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new HttpError(400, "Ожидается JSON-объект");
  const unknown = Object.keys(data).filter(
    (key) => !["text", "author", "category"].includes(key),
  );
  if (unknown.length) throw new HttpError(422, "Неизвестные поля: " + unknown.join(", "));

  return [
    text(data.text, "Цитата", 3, 2000),
    text(data.author, "Автор", 2, 100),
    text(data.category, "Категория", 2, 60),
  ];
}

function text(value, name, min, max) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max)
    throw new HttpError(422, `${name}: от ${min} до ${max} символов`);
  return value.trim();
}

export function methodNotAllowed(...methods) {
  return (req, res) => {
    res.set("Allow", methods.join(", ")).status(405).json({ error: "Метод не поддерживается" });
  };
}
