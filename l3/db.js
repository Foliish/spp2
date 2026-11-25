import pg from "pg";
import { readFile } from "node:fs/promises";

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function transaction(work) {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const result = await work(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function prepareDatabase() {
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await db.query(schema);
  if (process.env.SEED === "false") return;
  await db.query(`
    INSERT INTO quotes (text, author, category)
    SELECT sample.text, sample.author, sample.category
    FROM (VALUES
      ('Работа не волк. Никто не волк. Только волк — волк.', 'Джейсон Стетхем (интернет-мем)', 'Юмор'),
      ('Я знаю, что ничего не знаю.', 'Сократ', 'Философия'),
      ('Путь в тысячу ли начинается с первого шага.', 'Лао-цзы', 'Жизнь')
    ) AS sample(text, author, category)
    WHERE NOT EXISTS (SELECT 1 FROM quotes)
  `);
}
