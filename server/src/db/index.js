import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// 数据库连接池
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 测试连接
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * 执行查询
 */
export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text, duration, rows: res.rowCount });
  return res;
}

/**
 * 获取单个结果
 */
export async function queryOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

/**
 * 获取所有结果
 */
export async function queryAll(text, params) {
  const res = await query(text, params);
  return res.rows;
}

/**
 * 事务执行
 */
export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 关闭连接池
 */
export async function close() {
  await pool.end();
}

export default {
  query,
  queryOne,
  queryAll,
  transaction,
  close,
  pool
};
