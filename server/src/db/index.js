import pg from 'pg';
import dotenv from 'dotenv';
import { recordError, setErrorLogDbWriter } from '../services/error-log.js';

dotenv.config();

const { Pool } = pg;

const DB_RETRY_ATTEMPTS = Math.max(
  Number.parseInt(process.env.DB_RETRY_ATTEMPTS || '5', 10),
  1,
);
const DB_RETRY_BASE_DELAY_MS = Math.max(
  Number.parseInt(process.env.DB_RETRY_BASE_DELAY_MS || '1000', 10),
  100,
);
const DB_RETRY_MAX_DELAY_MS = Math.max(
  Number.parseInt(process.env.DB_RETRY_MAX_DELAY_MS || '15000', 10),
  DB_RETRY_BASE_DELAY_MS,
);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isTransientDatabaseError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return [
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now / startup
    '08000', // connection_exception
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08003', // connection_does_not_exist
    '08004', // sqlserver_rejected_establishment
    '08006', // connection_failure
    '08007', // transaction_resolution_unknown
    '08P01', // protocol_violation
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
  ].includes(code)
    || /connection terminated|connection timeout|database system is starting up|server closed the connection|socket hang up|timeout expired|could not connect/.test(message);
}

function retryDelay(attempt) {
  return Math.min(DB_RETRY_MAX_DELAY_MS, DB_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
}

async function runWithRetry(operation, { scope, queryText = null, params = null } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const transient = isTransientDatabaseError(error);
      if (!transient || attempt >= DB_RETRY_ATTEMPTS) {
        await recordError(scope, error, {
          attempt,
          max_attempts: DB_RETRY_ATTEMPTS,
          transient,
          query: queryText ? String(queryText).slice(0, 4_000) : null,
          parameter_count: Array.isArray(params) ? params.length : null,
        });
        throw error;
      }
      console.warn(`${scope} transient failure; retrying`, {
        attempt,
        max_attempts: DB_RETRY_ATTEMPTS,
        delay_ms: retryDelay(attempt),
        code: error.code || null,
        message: error.message,
      });
      await sleep(retryDelay(attempt));
    }
  }
  throw lastError;
}

// 数据库连接池
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.parseInt(process.env.DB_POOL_MAX || '20', 10),
  min: Number.parseInt(process.env.DB_POOL_MIN || '1', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: Number.parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000', 10),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

setErrorLogDbWriter(async entry => {
  await pool.query(
    `INSERT INTO error_logs (
       created_at, level, scope, message, error_name, error_code, stack,
       context, process_group, machine_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.created_at,
      entry.level,
      entry.scope,
      entry.message,
      entry.error?.name || null,
      entry.error?.code || null,
      entry.error?.stack || null,
      JSON.stringify({ error: entry.error, context: entry.context, process: entry.process }),
      entry.process.group,
      entry.process.machine_id,
    ],
  );
});

// 测试连接
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  void recordError('database.idle_client', err);
});

/**
 * 执行查询
 */
export async function query(text, params) {
  return await runWithRetry(async () => {
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  }, { scope: 'database.query', queryText: text, params });
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
  return await runWithRetry(async () => {
    const client = await pool.connect();
    let commitStarted = false;
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      commitStarted = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!commitStarted) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }, { scope: 'database.transaction' });
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

export { isTransientDatabaseError };
