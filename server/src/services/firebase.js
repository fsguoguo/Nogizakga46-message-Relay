import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import mediaArchive from './media.js';
import { recordError } from './error-log.js';

dotenv.config();

let firebaseApp = null;

function pushPayload(message) {
  const mediaUrl = message.media_local_path
    ? mediaArchive.publicUrl(message.id, 'media')
    : message.media_url;
  const thumbnailUrl = message.thumbnail_local_path
    ? mediaArchive.publicUrl(message.id, 'thumbnail')
    : message.thumbnail_url;
  const phoneImageUrl = message.phone_image_local_path
    ? mediaArchive.publicUrl(message.id, 'phone_image')
    : message.phone_image_url;

  return {
    id: message.id,
    member_id: message.member_id,
    member_name: message.member_name,
    member_avatar_url: message.member_avatar_url,
    phone_image_url: phoneImageUrl,
    type: message.type,
    text: message.text,
    media_url: mediaUrl,
    thumbnail_url: thumbnailUrl,
    duration_seconds: message.duration_seconds,
    sent_at: message.sent_at,
    incoming_call_from: message.incoming_call_from,
    ringtone_url: message.ringtone_url,
    is_played: message.is_played,
  };
}

/**
 * 初始化 Firebase Admin SDK
 */
export function initializeFirebase() {
  if (firebaseApp) {
    return firebaseApp;
  }

  try {
    let serviceAccount;

    // 支持 Base64 编码的密钥（用于 Fly.io 等平台）
    if (process.env.FIREBASE_PRIVATE_KEY_BASE64) {
      console.log('Using Firebase key from FIREBASE_PRIVATE_KEY_BASE64 env variable');
      const base64Key = process.env.FIREBASE_PRIVATE_KEY_BASE64;
      const jsonKey = Buffer.from(base64Key, 'base64').toString('utf8');
      serviceAccount = JSON.parse(jsonKey);
    } else if (process.env.FIREBASE_PRIVATE_KEY_JSON) {
      // 支持直接 JSON 字符串（另一种方式）
      console.log('Using Firebase key from FIREBASE_PRIVATE_KEY_JSON env variable');
      serviceAccount = JSON.parse(process.env.FIREBASE_PRIVATE_KEY_JSON);
    } else {
      // 从文件读取（本地开发）
      console.log('Using Firebase key from file:', process.env.FIREBASE_PRIVATE_KEY_PATH);
      serviceAccount = JSON.parse(
        readFileSync(process.env.FIREBASE_PRIVATE_KEY_PATH, 'utf8')
      );
    }

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });

    console.log('Firebase Admin SDK initialized');
    return firebaseApp;
  } catch (error) {
    void recordError('firebase.initialize', error);
    throw error;
  }
}

/**
 * 发送 FCM 推送通知
 * @param {string} token - FCM 设备 token
 * @param {object} message - 消息对象
 * @param {boolean} includePayload - 是否在 data 中包含完整 payload
 */
export async function sendPushNotification(token, message, includePayload = true) {
  if (!firebaseApp) {
    initializeFirebase();
  }

  const data = {
    message_id: message.id,
    type: message.type,
  };

  // 如果消息不大，直接携带完整 payload
  if (includePayload) {
    const payload = JSON.stringify(pushPayload(message));

    // FCM data 字段有大小限制（4KB），检查 payload 大小
    if (payload.length < 3800) {
      data.payload = payload;
    }
  }

  const fcmMessage = {
    data,
    android: {
      priority: 'high', // 高优先级，确保及时送达
    },
    token,
  };

  try {
    const response = await admin.messaging().send(fcmMessage);
    console.log('FCM push sent successfully:', response);
    return { success: true, messageId: response };
  } catch (error) {
    await recordError('firebase.push', error, { message_id: message.id, token_present: Boolean(token) });
    return { success: false, error: error.message };
  }
}

/**
 * 批量发送推送
 * @param {Array<string>} tokens - FCM tokens 数组
 * @param {object} message - 消息对象
 */
export async function sendMulticastPush(tokens, message) {
  if (!firebaseApp) {
    initializeFirebase();
  }

  if (!tokens || tokens.length === 0) {
    return { success: false, error: 'No tokens provided' };
  }

  const data = {
    message_id: message.id,
    type: message.type,
  };

  const payload = JSON.stringify(pushPayload(message));

  if (payload.length < 3800) {
    data.payload = payload;
  }

  const multicastMessage = {
    data,
    android: {
      priority: 'high',
    },
    tokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(multicastMessage);
    console.log(`FCM multicast: ${response.successCount} success, ${response.failureCount} failed`);
    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses,
    };
  } catch (error) {
    await recordError('firebase.multicast', error, { message_id: message.id, token_count: tokens.length });
    return { success: false, error: error.message };
  }
}

export default {
  initializeFirebase,
  sendPushNotification,
  sendMulticastPush,
};
