import db from '../db/index.js';
import mediaArchive from './media.js';

const NON_TEST_MESSAGE = "id !~ '^test[-_]'";

/**
 * 消息存储服务
 */
class MessageService {
  /**
   * 保存消息（带去重）
   */
  async saveMessage(message) {
    // 检查消息是否已存在
    const existing = await db.queryOne(
      'SELECT * FROM messages WHERE id = $1',
      [message.id]
    );

    if (existing) {
      // Retry media archival for rows created before local media storage was enabled.
      const needsPhoneImage = message.type === 'audio'
        && message.incoming_call_from
        && message.phone_image_url
        && !existing.phone_image_local_path;
      if ((message.media_url && !existing.media_local_path)
        || (message.thumbnail_url && !existing.thumbnail_local_path)
        || needsPhoneImage) {
        const archived = await mediaArchive.archiveMessage(message);
        if (archived.mediaLocalPath || archived.thumbnailLocalPath || archived.phoneImageLocalPath) {
          const updated = await db.queryOne(
            `UPDATE messages
             SET media_local_path = COALESCE($1, media_local_path),
                 thumbnail_local_path = COALESCE($2, thumbnail_local_path),
                 phone_image_local_path = COALESCE($3, phone_image_local_path)
             WHERE id = $4
             RETURNING *`,
            [archived.mediaLocalPath, archived.thumbnailLocalPath, archived.phoneImageLocalPath, message.id],
          );
          return { message: updated || existing, isNew: false };
        }
      }
      console.log(`Message ${message.id} already exists, skipping`);
      return { message: existing, isNew: false };
    }

    const archived = await mediaArchive.archiveMessage(message);

    // 插入新消息
    const result = await db.queryOne(
      `INSERT INTO messages (
        id, member_id, member_name, member_avatar_url, phone_image_url,
        type, text, media_url, thumbnail_url, duration_seconds,
        sent_at, incoming_call_from, ringtone_url, is_played, original_data,
        media_local_path, thumbnail_local_path, phone_image_local_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (id) DO NOTHING
      RETURNING *`,
      [
        message.id,
        message.member_id || null,
        message.member_name,
        message.member_avatar_url || null,
        message.phone_image_url || null,
        message.type,
        message.text || null,
        message.media_url || null,
        message.thumbnail_url || null,
        message.duration_seconds || null,
        message.sent_at,
        message.incoming_call_from || null,
        message.ringtone_url || null,
        message.is_played !== undefined ? message.is_played : false,
        JSON.stringify(message.original_data || {}),
        archived.mediaLocalPath,
        archived.thumbnailLocalPath,
        archived.phoneImageLocalPath,
      ]
    );

    if (result) return { message: result, isNew: true };

    // A connection can be lost after PostgreSQL commits an insert. The retry
    // then sees the conflict; treat that race as a successful existing row.
    const racedMessage = await db.queryOne(
      'SELECT * FROM messages WHERE id = $1',
      [message.id],
    );
    return { message: racedMessage || message, isNew: false };
  }

  async getStoredMediaPath(messageId, kind) {
    const message = await this.getMessage(messageId);
    if (!message) return null;
    const localPath = {
      media: message.media_local_path,
      thumbnail: message.thumbnail_local_path,
      phone_image: message.phone_image_local_path,
    }[kind];
    return mediaArchive.storedFile(localPath);
  }

  /**
   * 获取消息详情
   */
  async getMessage(messageId) {
    return await db.queryOne(
      `SELECT * FROM messages WHERE id = $1 AND ${NON_TEST_MESSAGE}`,
      [messageId]
    );
  }

  /**
   * 获取消息列表
   */
  async getMessages({ limit = 50, offset = 0, type = null, memberId = null }) {
    let query = `SELECT * FROM messages WHERE ${NON_TEST_MESSAGE}`;
    const params = [];
    let paramCount = 0;

    if (type) {
      paramCount++;
      query += ` AND type = $${paramCount}`;
      params.push(type);
    }

    if (memberId) {
      paramCount++;
      query += ` AND member_id = $${paramCount}`;
      params.push(memberId);
    }

    query += ` ORDER BY sent_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    return await db.queryAll(query, params);
  }

  /**
   * 更新消息播放状态
   */
  async markAsPlayed(messageId) {
    const result = await db.queryOne(
      'UPDATE messages SET is_played = true WHERE id = $1 RETURNING *',
      [messageId]
    );
    return result;
  }

  /**
   * 获取未播放的语音消息数量
   */
  async getUnplayedAudioCount() {
    const result = await db.queryOne(
      `SELECT COUNT(*) as count FROM messages
       WHERE ${NON_TEST_MESSAGE}
         AND type = 'audio' AND is_played = false AND incoming_call_from IS NOT NULL`
    );
    return parseInt(result.count, 10);
  }

  /**
   * 删除旧消息（清理任务）
   */
  async deleteOldMessages(daysToKeep = 30) {
    const result = await db.query(
      `DELETE FROM messages
       WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'`
    );
    return result.rowCount;
  }

  /**
   * 获取消息统计
   */
  async getStatistics() {
    const stats = await db.queryOne(
      `SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN type = 'text' THEN 1 END) as text_count,
        COUNT(CASE WHEN type = 'image' THEN 1 END) as image_count,
        COUNT(CASE WHEN type = 'audio' THEN 1 END) as audio_count,
        COUNT(CASE WHEN type = 'video' THEN 1 END) as video_count,
        COUNT(CASE WHEN type = 'audio' AND is_played = false THEN 1 END) as unplayed_audio
      FROM messages
      WHERE ${NON_TEST_MESSAGE}`
    );
    return stats;
  }
}

export default new MessageService();
