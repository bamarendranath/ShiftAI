import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString });
  let client;
  try {
    const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log('Database schema is up to date.');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Database migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
}
