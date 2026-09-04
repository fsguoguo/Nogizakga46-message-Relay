-- 设备表
CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    fcm_token VARCHAR(255) UNIQUE NOT NULL,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios')),
    label VARCHAR(100),
    user_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_devices_fcm_token ON devices(fcm_token);
CREATE INDEX idx_devices_user_id ON devices(user_id);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(100) PRIMARY KEY,
    member_id VARCHAR(50),
    member_name VARCHAR(100) NOT NULL,
    member_avatar_url TEXT,
    phone_image_url TEXT,
    type VARCHAR(20) NOT NULL CHECK (type IN ('text', 'image', 'audio', 'video')),
    text TEXT,
    media_url TEXT,
    thumbnail_url TEXT,
    duration_seconds INTEGER,
    sent_at TIMESTAMP NOT NULL,
    incoming_call_from VARCHAR(100),
    ringtone_url TEXT,
    is_played BOOLEAN DEFAULT FALSE,
    original_data JSONB,
    phone_image_local_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_sent_at ON messages(sent_at DESC);
CREATE INDEX idx_messages_type ON messages(type);
CREATE INDEX idx_messages_member_id ON messages(member_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);

-- 推送记录表
CREATE TABLE IF NOT EXISTS push_logs (
    id SERIAL PRIMARY KEY,
    message_id VARCHAR(100) NOT NULL,
    device_id INTEGER NOT NULL,
    fcm_message_id VARCHAR(255),
    status VARCHAR(20) CHECK (status IN ('success', 'failed', 'pending')),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX idx_push_logs_message_id ON push_logs(message_id);
CREATE INDEX idx_push_logs_device_id ON push_logs(device_id);
CREATE INDEX idx_push_logs_created_at ON push_logs(created_at DESC);
CREATE INDEX idx_push_logs_status ON push_logs(status);

-- 更新设备的 updated_at 触发器
CREATE OR REPLACE FUNCTION update_device_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_device_timestamp
BEFORE UPDATE ON devices
FOR EACH ROW
EXECUTE FUNCTION update_device_timestamp();
