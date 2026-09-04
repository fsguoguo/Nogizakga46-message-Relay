import { sendPushNotification, sendMulticastPush } from './firebase.js';
import deviceService from './device.js';
import db from '../db/index.js';

/**
 * 推送通知服务
 */
class PushService {
  /**
   * 向所有设备推送消息
   */
  async pushToAllDevices(message, userId = null) {
    const tokens = await deviceService.getAllTokens(userId);

    if (tokens.length === 0) {
      console.log('No devices to push to');
      return { success: false, error: 'No devices registered' };
    }

    console.log(`Pushing message ${message.id} to ${tokens.length} devices`);

    // 批量推送
    const result = await sendMulticastPush(tokens, message);

    // 记录推送日志
    await this.logPushResults(message.id, tokens, result);

    return result;
  }

  /**
   * 向单个设备推送
   */
  async pushToDevice(deviceId, message) {
    const device = await deviceService.getDevice(deviceId);

    if (!device) {
      return { success: false, error: 'Device not found' };
    }

    const result = await sendPushNotification(device.fcm_token, message);

    // 记录推送日志
    await this.logPush(message.id, deviceId, result);

    return result;
  }

  /**
   * 推送语音来电（全屏来电）
   */
  async pushAudioCall(message, userId = null) {
    // 确保是语音消息且有 incoming_call_from
    if (message.type !== 'audio' || !message.incoming_call_from) {
      console.warn('Message does not meet audio call criteria');
      return { success: false, error: 'Not an audio call message' };
    }

    // 确保 is_played 为 false
    if (message.is_played) {
      console.warn('Audio message already played, not triggering call');
      return { success: false, error: 'Message already played' };
    }

    console.log(`Pushing audio call from ${message.incoming_call_from}`);

    return await this.pushToAllDevices(message, userId);
  }

  /**
   * 推送普通消息
   */
  async pushMessage(message, userId = null) {
    console.log(`Pushing ${message.type} message: ${message.id}`);

    return await this.pushToAllDevices(message, userId);
  }

  /**
   * 推送不落库的临时测试消息。
   * 因为 push_logs.message_id 外键指向 messages，这里也不写推送日志，
   * 调用方应直接使用 Firebase 返回的 successCount/failureCount 判断结果。
   */
  async pushTransientMessage(message, userId = null) {
    const tokens = await deviceService.getAllTokens(userId);
    if (tokens.length === 0) {
      console.log('No devices to push transient message to');
      return { success: false, error: 'No devices registered' };
    }

    console.log(`Pushing transient ${message.type} message ${message.id} to ${tokens.length} devices`);
    return await sendMulticastPush(tokens, message);
  }

  /**
   * 推送不落库的临时语音来电。
   */
  async pushTransientAudioCall(message, userId = null) {
    if (message.type !== 'audio' || !message.incoming_call_from) {
      console.warn('Message does not meet transient audio call criteria');
      return { success: false, error: 'Not an audio call message' };
    }

    if (message.is_played) {
      console.warn('Transient audio message already played, not triggering call');
      return { success: false, error: 'Message already played' };
    }

    console.log(`Pushing transient audio call from ${message.incoming_call_from}`);
    return await this.pushTransientMessage(message, userId);
  }

  /**
   * 智能推送（根据消息类型自动选择推送方式）
   */
  async smartPush(message, userId = null) {
    // 检查是否应该触发全屏来电
    const shouldRing = message.type === 'audio'
      && message.incoming_call_from
      && !message.is_played;

    if (shouldRing) {
      return await this.pushAudioCall(message, userId);
    } else {
      return await this.pushMessage(message, userId);
    }
  }

  /**
   * 记录推送日志
   */
  async logPush(messageId, deviceId, result) {
    await db.query(
      `INSERT INTO push_logs (message_id, device_id, fcm_message_id, status, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        messageId,
        deviceId,
        result.messageId || null,
        result.success ? 'success' : 'failed',
        result.error || null,
      ]
    );
  }

  /**
   * 批量记录推送日志
   */
  async logPushResults(messageId, tokens, result) {
    if (!result.responses) {
      return;
    }

    const devices = await db.queryAll(
      'SELECT id, fcm_token FROM devices WHERE fcm_token = ANY($1)',
      [tokens]
    );

    const deviceMap = new Map(devices.map(d => [d.fcm_token, d.id]));

    for (let i = 0; i < result.responses.length; i++) {
      const response = result.responses[i];
      const token = tokens[i];
      const deviceId = deviceMap.get(token);

      if (deviceId) {
        await db.query(
          `INSERT INTO push_logs (message_id, device_id, fcm_message_id, status, error_message)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            messageId,
            deviceId,
            response.messageId || null,
            response.success ? 'success' : 'failed',
            response.error?.message || null,
          ]
        );
      }
    }
  }

  /**
   * 获取推送日志
   */
  async getPushLogs({ messageId = null, deviceId = null, limit = 50 }) {
    let query = 'SELECT * FROM push_logs WHERE 1=1';
    const params = [];
    let paramCount = 0;

    if (messageId) {
      paramCount++;
      query += ` AND message_id = $${paramCount}`;
      params.push(messageId);
    }

    if (deviceId) {
      paramCount++;
      query += ` AND device_id = $${paramCount}`;
      params.push(deviceId);
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1}`;
    params.push(limit);

    return await db.queryAll(query, params);
  }
}

export default new PushService();
