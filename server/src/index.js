import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import { initializeFirebase } from './services/firebase.js';
import { authenticate, errorHandler, notFound, requestLogger } from './middleware/auth.js';
import devicesRouter from './routes/devices.js';
import messagesRouter from './routes/messages.js';
import pushRouter from './routes/push.js';
import { pool, query as dbQuery } from './db/index.js';
import mediaArchive from './services/media.js';
import { recordError } from './services/error-log.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化 Firebase
try {
  initializeFirebase();
} catch (error) {
  await recordError('server.firebase_initialize', error);
  process.exit(1);
}

// 中间件
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 100, // 限制 100 个请求
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/v1/', limiter);

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 数据库初始化端点（仅用于首次部署）
app.post('/init-db', authenticate, async (req, res) => {
  try {
    const schemaSQL = `
      -- 创建设备表
      CREATE TABLE IF NOT EXISTS devices (
          id SERIAL PRIMARY KEY,
          fcm_token TEXT NOT NULL UNIQUE,
          platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios')),
          label VARCHAR(255),
          user_id VARCHAR(255),
          last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_devices_fcm_token ON devices(fcm_token);

      -- 创建消息表
      CREATE TABLE IF NOT EXISTS messages (
          id VARCHAR(255) PRIMARY KEY,
          member_id VARCHAR(255),
          member_name VARCHAR(255) NOT NULL,
          member_avatar_url TEXT,
          phone_image_url TEXT,
          type VARCHAR(20) NOT NULL CHECK (type IN ('text', 'image', 'audio', 'video')),
          text TEXT,
          media_url TEXT,
          thumbnail_url TEXT,
          duration_seconds INTEGER,
          sent_at TIMESTAMP NOT NULL,
          incoming_call_from VARCHAR(255),
          ringtone_url TEXT,
          is_played BOOLEAN DEFAULT false,
          original_data JSONB,
          media_local_path TEXT,
          thumbnail_local_path TEXT,
          phone_image_local_path TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_local_path TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS thumbnail_local_path TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS phone_image_local_path TEXT;

      CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
      CREATE INDEX IF NOT EXISTS idx_messages_member_id ON messages(member_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_is_played ON messages(is_played) WHERE type = 'audio';

      -- 创建推送日志表
      CREATE TABLE IF NOT EXISTS push_logs (
          id SERIAL PRIMARY KEY,
          message_id VARCHAR(255) NOT NULL,
          device_id INTEGER,
          fcm_message_id TEXT,
          status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'failed')),
          error_message TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
          FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_push_logs_message_id ON push_logs(message_id);
      CREATE INDEX IF NOT EXISTS idx_push_logs_device_id ON push_logs(device_id);
      CREATE INDEX IF NOT EXISTS idx_push_logs_status ON push_logs(status);
      CREATE INDEX IF NOT EXISTS idx_push_logs_created_at ON push_logs(created_at DESC);

      -- 持久化结构化错误日志，便于在 Fly 日志轮转后追查故障
      CREATE TABLE IF NOT EXISTS error_logs (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          level VARCHAR(20) NOT NULL,
          scope VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          error_name VARCHAR(255),
          error_code VARCHAR(100),
          stack TEXT,
          context JSONB,
          process_group VARCHAR(100),
          machine_id VARCHAR(255)
      );

      CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_error_logs_scope ON error_logs(scope);

      -- 创建成员表
      CREATE TABLE IF NOT EXISTS members (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          avatar_url TEXT,
          phone_image_url TEXT,
          generation INTEGER,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_members_name ON members(name);
      CREATE INDEX IF NOT EXISTS idx_members_generation ON members(generation);

      -- 插入测试数据
      INSERT INTO members (id, name, generation) VALUES
          ('saito_asuka', '齋藤飛鳥', 1),
          ('shiraishi_mai', '白石麻衣', 1),
          ('ikuta_erika', '生田絵梨花', 1),
          ('nishino_nanase', '西野七瀬', 1)
      ON CONFLICT (id) DO NOTHING;

      -- 创建触发器
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ language 'plpgsql';

      DROP TRIGGER IF EXISTS update_members_updated_at ON members;
      CREATE TRIGGER update_members_updated_at BEFORE UPDATE ON members
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;

    await dbQuery(schemaSQL);

    res.json({
      success: true,
      message: 'Database initialized successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    await recordError('server.database_initialize', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// API 路由（需要认证）
app.use('/v1/devices', authenticate, devicesRouter);
app.use('/v1/messages', authenticate, messagesRouter);
app.use('/v1/push', authenticate, pushRouter);

// Keep existing deployments compatible with media archival columns added
// after the original messages table was created. Both statements are
// idempotent and do not alter existing message rows.
async function ensureMessageMediaColumns() {
  try {
    await dbQuery(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_local_path TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS thumbnail_local_path TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS phone_image_local_path TEXT;
      CREATE TABLE IF NOT EXISTS error_logs (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          level VARCHAR(20) NOT NULL,
          scope VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          error_name VARCHAR(255),
          error_code VARCHAR(100),
          stack TEXT,
          context JSONB,
          process_group VARCHAR(100),
          machine_id VARCHAR(255)
      );
      CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_error_logs_scope ON error_logs(scope);
    `);
    console.log('Database message media columns verified');
  } catch (error) {
    await recordError('server.database_migration', error);
  }
}

await ensureMessageMediaColumns();

// Remove rows written by older test-call implementations so they cannot be
// returned by history sync or counted as real messages after a restart.
async function cleanupTransientTestMessages() {
  try {
    const result = await dbQuery("DELETE FROM messages WHERE id ~ '^test[-_]'");
    if (result.rowCount > 0) {
      console.log(`Removed ${result.rowCount} transient test message(s)`);
    }
  } catch (error) {
    await recordError('server.test_message_cleanup', error);
  }
}

await cleanupTransientTestMessages();

// 404 处理
app.use(notFound);

// 错误处理
app.use(errorHandler);

// 启动服务器
const server = app.listen(PORT, () => {
  console.log(`🚀 Nogi Relay Server running on port ${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase initialized`);
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`${signal} signal received: closing HTTP server`);
  try {
    await pool.end();
  } finally {
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', error => {
  void recordError('server.uncaught_exception', error).finally(() => process.exit(1));
});
process.on('unhandledRejection', reason => {
  void recordError('server.unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

export default app;
