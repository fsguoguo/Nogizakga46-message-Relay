import db from '../db/index.js';

/**
 * 设备管理服务
 */
class DeviceService {
  /**
   * 注册或更新设备
   */
  async registerDevice({ fcmToken, platform, label, userId }) {
    const existing = await db.queryOne(
      'SELECT id FROM devices WHERE fcm_token = $1',
      [fcmToken]
    );

    if (existing) {
      // 更新现有设备
      const result = await db.queryOne(
        `UPDATE devices
         SET platform = $1, label = $2, user_id = $3, last_seen_at = CURRENT_TIMESTAMP
         WHERE fcm_token = $4
         RETURNING *`,
        [platform, label, userId, fcmToken]
      );
      return { device: result, isNew: false };
    } else {
      // 注册新设备
      const result = await db.queryOne(
        `INSERT INTO devices (fcm_token, platform, label, user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [fcmToken, platform, label, userId]
      );
      return { device: result, isNew: true };
    }
  }

  /**
   * 获取所有活跃设备
   */
  async getAllDevices(userId = null) {
    if (userId) {
      return await db.queryAll(
        'SELECT * FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC',
        [userId]
      );
    }
    return await db.queryAll(
      'SELECT * FROM devices ORDER BY last_seen_at DESC'
    );
  }

  /**
   * 获取设备详情
   */
  async getDevice(deviceId) {
    return await db.queryOne(
      'SELECT * FROM devices WHERE id = $1',
      [deviceId]
    );
  }

  /**
   * 删除设备
   */
  async deleteDevice(deviceId) {
    const result = await db.query(
      'DELETE FROM devices WHERE id = $1',
      [deviceId]
    );
    return result.rowCount > 0;
  }

  /**
   * 通过 FCM token 删除设备
   */
  async deleteDeviceByToken(fcmToken) {
    const result = await db.query(
      'DELETE FROM devices WHERE fcm_token = $1',
      [fcmToken]
    );
    return result.rowCount > 0;
  }

  /**
   * 更新设备最后活跃时间
   */
  async updateLastSeen(fcmToken) {
    await db.query(
      'UPDATE devices SET last_seen_at = CURRENT_TIMESTAMP WHERE fcm_token = $1',
      [fcmToken]
    );
  }

  /**
   * 获取所有 FCM tokens
   */
  async getAllTokens(userId = null) {
    let rows;
    if (userId) {
      rows = await db.queryAll(
        'SELECT fcm_token FROM devices WHERE user_id = $1',
        [userId]
      );
    } else {
      rows = await db.queryAll('SELECT fcm_token FROM devices');
    }
    return rows.map(row => row.fcm_token);
  }
}

export default new DeviceService();
