import express from 'express';
import { randomUUID } from 'node:crypto';
import pushService from '../services/push.js';
import messageService from '../services/message.js';

const router = express.Router();

/**
 * POST /v1/push/send
 * 手动发送推送（测试用）
 */
router.post('/send', async (req, res) => {
  try {
    const { message_id, user_id } = req.body;

    if (!message_id) {
      return res.status(400).json({
        error: 'Missing required field: message_id'
      });
    }

    const message = await messageService.getMessage(message_id);

    if (!message) {
      return res.status(404).json({
        error: 'Message not found'
      });
    }

    const result = await pushService.smartPush(message, user_id);

    res.json({
      success: result.success,
      result,
    });
  } catch (error) {
    console.error('Send push error:', error);
    res.status(500).json({
      error: 'Failed to send push notification',
      message: error.message,
    });
  }
});

/**
 * POST /v1/push/test-message
 * 创建一条临时普通文字消息并推送，用于验证完整 FCM 通知链路。
 * 测试消息不会写入服务器消息数据库。
 */
router.post('/test-message', async (req, res) => {
  try {
    const { member_name, text, user_id } = req.body;
    if (text != null && (typeof text !== 'string' || !text.trim())) {
      return res.status(400).json({
        error: 'Invalid field: text must be a non-empty string',
      });
    }
    if (typeof text === 'string' && Buffer.byteLength(text.trim(), 'utf8') > 2000) {
      return res.status(400).json({
        error: 'Invalid field: text must not exceed 2000 UTF-8 bytes',
      });
    }
    if (member_name != null && (typeof member_name !== 'string' || !member_name.trim())) {
      return res.status(400).json({
        error: 'Invalid field: member_name must be a non-empty string',
      });
    }

    const testMessage = {
      id: `test-message-${Date.now()}-${randomUUID()}`,
      member_id: 'test_message_member',
      member_name: member_name?.trim().slice(0, 100) || 'Nogi Relay',
      member_avatar_url: null,
      phone_image_url: null,
      type: 'text',
      text: text?.trim() || '这是一条普通消息推送测试',
      media_url: null,
      thumbnail_url: null,
      duration_seconds: null,
      sent_at: new Date().toISOString(),
      incoming_call_from: null,
      ringtone_url: null,
      is_played: false,
      original_data: { test: true, kind: 'message' },
    };

    const result = await pushService.pushTransientMessage(testMessage, user_id);

    res.json({
      success: result.success,
      message: testMessage,
      result,
    });
  } catch (error) {
    console.error('Test message error:', error);
    res.status(500).json({
      error: 'Failed to send test message',
      message: error.message,
    });
  }
});

/**
 * POST /v1/push/test-call
 * 测试全屏来电推送
 */
router.post('/test-call', async (req, res) => {
  try {
    const { member_name, user_id } = req.body;

    // 创建测试消息
    const testMessage = {
      id: `test-call-${Date.now()}-${randomUUID()}`,
      member_id: 'test_member',
      member_name: member_name || '齋藤飛鳥',
      member_avatar_url: null,
      phone_image_url: null,
      type: 'audio',
      text: null,
      media_url: 'https://example.com/test-audio.mp3',
      thumbnail_url: null,
      duration_seconds: 30,
      sent_at: new Date().toISOString(),
      incoming_call_from: member_name || '齋藤飛鳥',
      ringtone_url: null,
      is_played: false,
      original_data: { test: true },
    };

    // 测试来电只用于验证 FCM 和客户端全屏来电链路，不保存消息或推送日志。
    const result = await pushService.pushTransientAudioCall(testMessage, user_id);

    res.json({
      success: result.success,
      message: testMessage,
      result,
    });
  } catch (error) {
    console.error('Test call error:', error);
    res.status(500).json({
      error: 'Failed to send test call',
      message: error.message,
    });
  }
});

/**
 * GET /v1/push/logs
 * 获取推送日志
 */
router.get('/logs', async (req, res) => {
  try {
    const messageId = req.query.message_id || null;
    const deviceId = req.query.device_id ? parseInt(req.query.device_id, 10) : null;
    const limit = parseInt(req.query.limit, 10) || 50;

    const logs = await pushService.getPushLogs({
      messageId,
      deviceId,
      limit,
    });

    res.json({
      success: true,
      logs,
    });
  } catch (error) {
    console.error('Get push logs error:', error);
    res.status(500).json({
      error: 'Failed to get push logs',
      message: error.message,
    });
  }
});

export default router;
