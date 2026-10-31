import pg from "pg";

export const dataDir = process.env.DATA_DIR || "./data";
const database = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const query = (sql, values = []) => database.query(sql, values);

await query(`
  CREATE TABLE IF NOT EXISTS quotes (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    author VARCHAR(100) NOT NULL,
    category VARCHAR(60) NOT NULL,
    image TEXT
  )
`);
