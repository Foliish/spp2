export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function jsonBody(req) {
  if (!req.is("application/json")) throw new HttpError(415, "Ожидается JSON");
  if (!req.body || Array.isArray(req.body) || typeof req.body !== "object") {
    throw new HttpError(400, "Ожидается объект");
  }
  return req.body;
}

export function positiveId(value) {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(id) || id < 1 || id > 2147483647) {
    throw new HttpError(404, "Ресурс не найден");
  }
  return id;
}

export function allow(...methods) {
  return () => {
    throw new HttpError(405, "Метод не поддерживается", { Allow: methods.join(", ") });
  };
}

export function unauthorized(message = "Войдите в систему") {
  return new HttpError(401, message, { "WWW-Authenticate": "Bearer" });
}
