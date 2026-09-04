-- 数据库初始化脚本

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

CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_fcm_token ON devices(fcm_token);

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

CREATE INDEX idx_messages_type ON messages(type);
CREATE INDEX idx_messages_member_id ON messages(member_id);
CREATE INDEX idx_messages_sent_at ON messages(sent_at DESC);
CREATE INDEX idx_messages_is_played ON messages(is_played) WHERE type = 'audio';

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

CREATE INDEX idx_push_logs_message_id ON push_logs(message_id);
CREATE INDEX idx_push_logs_device_id ON push_logs(device_id);
CREATE INDEX idx_push_logs_status ON push_logs(status);
CREATE INDEX idx_push_logs_created_at ON push_logs(created_at DESC);

-- 持久化结构化错误日志
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

-- 创建成员表（可选，用于存储成员信息）
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

CREATE INDEX idx_members_name ON members(name);
CREATE INDEX idx_members_generation ON members(generation);

-- 插入测试数据（可选）
INSERT INTO members (id, name, generation) VALUES
    ('saito_asuka', '齋藤飛鳥', 1),
    ('shiraishi_mai', '白石麻衣', 1),
    ('ikuta_erika', '生田絵梨花', 1),
    ('nishino_nanase', '西野七瀬', 1)
ON CONFLICT (id) DO NOTHING;

-- 创建触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_members_updated_at BEFORE UPDATE ON members
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 授予权限（根据实际用户调整）
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_user;

COMMENT ON TABLE devices IS '设备注册表，存储 FCM tokens';
COMMENT ON TABLE messages IS '消息表，存储所有从官网接收的消息';
COMMENT ON TABLE push_logs IS '推送日志表，记录每次推送的结果';
COMMENT ON TABLE members IS '成员信息表';
