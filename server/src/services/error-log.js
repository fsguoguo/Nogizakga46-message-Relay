import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_LOG_DIR = process.env.LOG_STORAGE_DIR
  || (process.env.NODE_ENV === 'production' ? '/data/nogi-logs' : './logs');
const MAX_CONTEXT_LENGTH = 20_000;
const MAX_LOG_FILE_BYTES = Math.max(
  Number.parseInt(process.env.LOG_MAX_FILE_BYTES || `${25 * 1024 * 1024}`, 10),
  1 * 1024 * 1024,
);
const LOG_RETENTION_DAYS = Math.max(
  Number.parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
  1,
);
const SENSITIVE_KEY = /^(authorization|cookie|token|access_token|refresh_token|fcm_token|secret|password|database_url)$/i;
const CONSOLE_MARKER = Symbol.for('nogi.relay.persistent-error-logger');

let dbWriter = null;
let fileWriteChain = Promise.resolve();
let lastPruneAt = 0;
const nativeConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

function truncate(value, maxLength = MAX_CONTEXT_LENGTH) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
}

function errorDetails(error) {
  if (!error) return null;
  return {
    name: error.name || null,
    message: error.message || String(error),
    code: error.code || null,
    errno: error.errno || null,
    syscall: error.syscall || null,
    address: error.address || null,
    port: error.port || null,
    stack: error.stack || null,
    cause: error.cause ? errorDetails(error.cause) : null,
  };
}

function sanitize(value, key = '', seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key) || /private.?key/i.test(key)) return '[REDACTED]';
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Error) return errorDetails(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, '', seen));
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    sanitize(entryValue, entryKey, seen),
  ]));
}

function safeContext(value) {
  try {
    const serialized = JSON.stringify(value ?? {});
    if (serialized.length <= MAX_CONTEXT_LENGTH) return value ?? {};
    return {
      truncated: true,
      serialized: `${serialized.slice(0, MAX_CONTEXT_LENGTH)}...[truncated]`,
    };
  } catch (serializationError) {
    return {
      serialization_error: serializationError.message,
      value: String(value),
    };
  }
}

function processGroup() {
  return process.env.FLY_PROCESS_GROUP || process.env.PROCESS_GROUP || 'unknown';
}

function machineId() {
  return process.env.FLY_MACHINE_ID || process.env.HOSTNAME || os.hostname();
}

function buildEntry(level, scope, error, context) {
  const details = context && typeof context === 'object' ? sanitize(context) : {};
  return {
    created_at: new Date().toISOString(),
    level,
    scope,
    message: truncate(error?.message || details.message || 'Unknown error', 4_000),
    error: errorDetails(error),
    context: safeContext(details),
    process: {
      pid: process.pid,
      group: processGroup(),
      machine_id: machineId(),
      node: process.version,
      uptime_seconds: Math.round(process.uptime()),
    },
  };
}

function consoleEntry(level, args) {
  const values = args.map(value => sanitize(value));
  const error = args.find(value => value instanceof Error) || null;
  return {
    created_at: new Date().toISOString(),
    level,
    scope: `console.${level}`,
    message: truncate(values.map(value => (
      typeof value === 'string' ? value : JSON.stringify(value)
    )).join(' '), 4_000),
    error: errorDetails(error),
    context: { arguments: values },
    process: {
      pid: process.pid,
      group: processGroup(),
      machine_id: machineId(),
      node: process.version,
      uptime_seconds: Math.round(process.uptime()),
    },
  };
}

export function setErrorLogDbWriter(writer) {
  dbWriter = typeof writer === 'function' ? writer : null;
}

async function appendFile(entry) {
  const date = entry.created_at.slice(0, 10);
  const line = `${JSON.stringify(entry)}\n`;
  const directories = [path.resolve(DEFAULT_LOG_DIR)];
  const fallbackDirectory = path.resolve('./logs');
  if (!directories.includes(fallbackDirectory)) directories.push(fallbackDirectory);
  fileWriteChain = fileWriteChain
    .then(async () => {
      let lastError;
      for (const directory of directories) {
        try {
          await fs.mkdir(directory, { recursive: true });
          const filePath = path.join(directory, `errors-${date}.jsonl`);
          await rotateIfNeeded(filePath, Buffer.byteLength(line, 'utf8'));
          await fs.appendFile(filePath, line, { mode: 0o600 });
          if (Date.now() - lastPruneAt > 60 * 60 * 1000) {
            lastPruneAt = Date.now();
            await pruneLogs(directory);
          }
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })
    .catch(() => {});
  return fileWriteChain;
}

async function rotateIfNeeded(filePath, incomingBytes) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.size + incomingBytes <= MAX_LOG_FILE_BYTES) return;
  for (let index = 3; index >= 1; index--) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    await fs.rename(source, target).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function pruneLogs(directory) {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter(entry => entry.isFile() && /^errors-\d{4}-\d{2}-\d{2}\.jsonl(?:\.\d+)?$/.test(entry.name))
    .map(async entry => {
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) await fs.rm(filePath, { force: true });
    }));
}

function installPersistentConsoleLogging() {
  if (globalThis[CONSOLE_MARKER]) return;
  globalThis[CONSOLE_MARKER] = true;
  console.error = (...args) => {
    nativeConsole.error(...args);
    const entry = consoleEntry('error', args);
    void appendFile(entry);
    if (dbWriter) void Promise.resolve(dbWriter(entry)).catch(() => {});
  };
  console.warn = (...args) => {
    nativeConsole.warn(...args);
    const entry = consoleEntry('warn', args);
    void appendFile(entry);
    if (dbWriter) void Promise.resolve(dbWriter(entry)).catch(() => {});
  };
}

/**
 * Keep a complete structured error in platform logs and durable storage.
 * Database persistence is best effort so logging can never create a failure loop.
 */
export async function recordError(scope, error, context = {}) {
  const entry = buildEntry('error', scope, error, context);
  nativeConsole.error(`[${scope}] ${entry.message}`, entry);
  await appendFile(entry);
  if (dbWriter) {
    // Do not block the caller on a database that may be the source of the error.
    void Promise.resolve(dbWriter(entry)).catch(() => {});
  }
  return entry;
}

export async function recordWarning(scope, message, context = {}) {
  const entry = buildEntry('warn', scope, { name: 'Warning', message }, context);
  nativeConsole.warn(`[${scope}] ${entry.message}`, entry);
  await appendFile(entry);
  if (dbWriter) void Promise.resolve(dbWriter(entry)).catch(() => {});
  return entry;
}

installPersistentConsoleLogging();

export default { setErrorLogDbWriter, recordError, recordWarning };
