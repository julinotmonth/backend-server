import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://reethau:reethau_dev_pw@localhost:5432/reethau_inventory';

export const pool = new Pool({ connectionString });

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle PostgreSQL client', err);
});

/** Thin query helper — every route goes through this, so swapping drivers
 * or adding query logging/metrics later only touches this one function. */
export async function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
