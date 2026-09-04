import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import messageService from '../services/message.js';
import pushService from '../services/push.js';
import mediaArchive from '../services/media.js';
import { recordError } from '../services/error-log.js';

dotenv.config();

const DEFAULT_API_URL = 'https://api.message.nogizaka46.com';
const DEFAULT_APP_ID = 'jp.co.sonymusic.communication.nogizaka 2.5';
const DEFAULT_PLATFORM = 'web';
const DEFAULT_ORGANIZATION_ID = '1';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MESSAGE_COUNT = 200;
const DEFAULT_TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const AUTH_TKN_HEADER = 'auth_tkn_nogizaka46.com';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseGroupIds(value) {
  return String(value || '')
    .split(',')
    .map(item => Number.parseInt(item.trim(), 10))
    .filter(Number.isInteger)
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

function tokenExpiry(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(decoded.exp) ? new Date(decoded.exp * 1000) : null;
  } catch {
    return null;
  }
}

function normalizeType(type) {
  const typeMap = {
    text: 'text',
    article: 'text',
    picture: 'image',
    photo: 'image',
    image: 'image',
    audio: 'audio',
    voice: 'audio',
    call: 'audio',
    video: 'video',
    movie: 'video',
  };
  return typeMap[String(type || '').toLowerCase()] || 'text';
}

function firstNonEmpty(...values) {
  return values.find(value => value != null && String(value).trim() !== '') ?? null;
}

/**
 * Polls the official message API, stores new timeline entries, and pushes them.
 * The access token is supplied through Fly secrets instead of being committed.
 */
class NogiWebMonitor {
  constructor({ fetchImpl = globalThis.fetch, messageStore = messageService, pusher = pushService } = {}) {
    this.fetchImpl = fetchImpl;
    this.messageStore = messageStore;
    this.pusher = pusher;
    this.apiUrl = (process.env.NOGI_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
    this.appId = process.env.NOGI_APP_ID || DEFAULT_APP_ID;
    this.platform = process.env.NOGI_APP_PLATFORM || DEFAULT_PLATFORM;
    this.organizationId = process.env.NOGI_ORGANIZATION_ID || DEFAULT_ORGANIZATION_ID;
    this.groupIds = parseGroupIds(process.env.NOGI_GROUP_IDS);
    this.messageCount = Math.min(
      Math.max(Number.parseInt(process.env.NOGI_MESSAGE_COUNT || DEFAULT_MESSAGE_COUNT, 10), 1),
      DEFAULT_MESSAGE_COUNT,
    );
    this.pollIntervalMs = Math.max(
      Number.parseInt(process.env.NOGI_POLL_INTERVAL_SECONDS || '60', 10) * 1000,
      15_000,
    ) || DEFAULT_POLL_INTERVAL_MS;
    this.backfillOnStart = parseBoolean(process.env.NOGI_BACKFILL_ON_START, true);
    this.accessToken = process.env.NOGI_ACCESS_TOKEN?.trim() || '';
    this.refreshToken = process.env.NOGI_REFRESH_TOKEN?.trim() || '';
    this.authTkn = (process.env.NOGI_AUTH_TKN || process.env.NOGI_AUTH_TOKEN || '').trim();
    this.tokenFile = process.env.NOGI_TOKEN_FILE || '/app/nogi-token.json';
    this.tokenRefreshIntervalMs = Math.max(
      Number.parseInt(process.env.NOGI_TOKEN_REFRESH_INTERVAL_MINUTES || '30', 10) * 60_000,
      5 * 60_000,
    ) || DEFAULT_TOKEN_REFRESH_INTERVAL_MS;
    this.lastRefreshAt = 0;
    this.isRunning = false;
    this.hasCompletedInitialPoll = false;
    this.loopPromise = null;
    this.groupMessageIds = new Map();
  }

  async start() {
    if (this.isRunning) return this.loopPromise;

    await this.loadTokenState();

    if (!this.accessToken) {
      console.warn('Nogi monitor disabled: NOGI_ACCESS_TOKEN is not configured');
      return;
    }

    this.isRunning = true;
    const expiresAt = tokenExpiry(this.accessToken);
    if (expiresAt) console.log(`Nogi monitor access token expires at ${expiresAt.toISOString()}`);
    if (this.refreshToken && (!expiresAt || expiresAt.getTime() - Date.now() <= this.tokenRefreshIntervalMs)) {
      try {
        await this.refreshAccessToken();
      } catch (error) {
        console.warn('Nogi monitor startup token refresh failed:', error.message);
      }
    }
    this.loopPromise = this.runLoop();
    return this.loopPromise;
  }

  async runLoop() {
    try {
      while (this.isRunning) {
        try {
          await this.refreshIfDue();
          await this.poll();
        } catch (error) {
          await recordError('monitor.poll', error, { mode: 'direct', has_access_token: Boolean(this.accessToken) });
        }

        if (this.isRunning) await sleep(this.pollIntervalMs);
      }
    } finally {
      this.loopPromise = null;
    }
  }

  async stop() {
    this.isRunning = false;
    if (this.loopPromise) await this.loopPromise;
  }

  async loadTokenState() {
    try {
      const state = JSON.parse(await fs.readFile(this.tokenFile, 'utf8'));
      const persistedAccessToken = String(state.accessToken || '').trim();
      const persistedRefreshToken = String(state.refreshToken || '').trim();
      const persistedAuthTkn = String(state.authTkn || '').trim();
      // Once the worker has rotated a token, the volume is the authoritative
      // source. Otherwise an old Fly secret would overwrite the rotated pair
      // after every restart and the next refresh would fail.
      if (persistedAccessToken && persistedRefreshToken) {
        this.accessToken = persistedAccessToken;
        this.refreshToken = persistedRefreshToken;
        if (persistedAuthTkn) this.authTkn = persistedAuthTkn;
        this.lastRefreshAt = Number(state.savedAt) || 0;
      } else {
        if (!this.accessToken && persistedAccessToken) this.accessToken = persistedAccessToken;
        if (!this.refreshToken && persistedRefreshToken) this.refreshToken = persistedRefreshToken;
        this.lastRefreshAt = Number(state.savedAt) || 0;
      }
      if (!this.authTkn && persistedAuthTkn) this.authTkn = persistedAuthTkn;
    } catch {
      // Environment secrets are the normal source on first startup.
    }
  }

  async persistTokenState() {
    if (!this.accessToken) return;
    try {
      await fs.writeFile(this.tokenFile, JSON.stringify({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken || null,
        authTkn: this.authTkn || null,
        savedAt: this.lastRefreshAt,
      }), { mode: 0o600 });
    } catch (error) {
      console.warn('Nogi monitor could not persist token state:', error.message);
    }
  }

  async refreshIfDue() {
    if (!this.refreshToken) return;
    const expiresAt = tokenExpiry(this.accessToken);
    const due = Date.now() - this.lastRefreshAt >= this.tokenRefreshIntervalMs;
    const expiring = expiresAt && expiresAt.getTime() - Date.now() <= 5 * 60_000;
    if (due || expiring) await this.refreshAccessToken();
  }

  headers(includeAuth = true, includeAuthTkn = false) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Talk-App-ID': this.appId,
      'X-Talk-App-Platform': this.platform,
      'Accept-Language': process.env.NOGI_ACCEPT_LANGUAGE || 'zh-CN,en-US,ja',
    };
    if (includeAuth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (includeAuthTkn && this.authTkn) {
      // The website sends this value on update_token. Keep both forms because
      // deployments of the official API have accepted it as a custom header
      // and as a cookie at different times.
      headers[AUTH_TKN_HEADER] = this.authTkn;
      headers.Cookie = `${AUTH_TKN_HEADER}=${this.authTkn}`;
    }
    return headers;
  }

  async request(path, { method = 'GET', body = undefined, retryAuth = true } = {}) {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: this.headers(path !== '/v2/update_token', path === '/v2/update_token'),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401 && retryAuth && this.refreshToken) {
      await this.refreshAccessToken();
      return this.request(path, { method, body, retryAuth: false });
    }

    const responseText = await response.text();
    let payload = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }
    }

    if (!response.ok) {
      const detail = typeof payload === 'string' ? payload : payload?.message || payload?.error;
      throw new Error(`Nogi API ${response.status} ${path}${detail ? `: ${detail}` : ''}`);
    }
    return payload;
  }

  async refreshAccessToken() {
    const payload = await this.request('/v2/update_token', {
      method: 'POST',
      body: { refresh_token: this.refreshToken },
      retryAuth: false,
    });
    if (!payload?.access_token) throw new Error('Nogi API refresh returned no access token');
    this.accessToken = payload.access_token;
    if (payload.refresh_token) this.refreshToken = payload.refresh_token;
    const returnedAuthTkn = payload[AUTH_TKN_HEADER] || payload.auth_tkn || payload.auth_token;
    if (returnedAuthTkn) this.authTkn = String(returnedAuthTkn).trim();
    this.lastRefreshAt = Date.now();
    await this.persistTokenState();
    console.log('Nogi monitor access token refreshed');
  }

  async resolveGroups() {
    if (this.groupIds.length > 0) {
      return this.groupIds.map(id => ({ id, name: '', phone_image: null, thumbnail: null }));
    }

    const groups = await this.request(`/v2/groups?organization_id=${encodeURIComponent(this.organizationId)}`);
    if (!Array.isArray(groups)) throw new Error('Nogi API groups response is not an array');

    return groups
      .filter(group => String(group.organization_id) === String(this.organizationId))
      .filter(group => group.state === 'open')
      .filter(group => group.subscription?.state === 'active')
      .map(group => ({
        id: Number(group.id),
        name: String(group.name || '').trim(),
        phone_image: group.phone_image || null,
        thumbnail: group.thumbnail || null,
      }))
      .filter(group => Number.isInteger(group.id));
  }

  async fetchTimeline(groupId) {
    const query = new URLSearchParams({
      count: String(this.messageCount),
      order: 'desc',
      clear_unread: 'false',
    });
    const payload = await this.request(`/v2/groups/${encodeURIComponent(groupId)}/timeline?${query}`);
    if (!payload || !Array.isArray(payload.messages)) {
      throw new Error(`Nogi API timeline response for group ${groupId} is invalid`);
    }
    return payload.messages;
  }

  normalizeMessage(rawMessage, group) {
    const type = normalizeType(rawMessage.type || rawMessage.content_type);
    const memberName = firstNonEmpty(rawMessage.member_name, rawMessage.memberName, group.name, '乃木坂46');
    const sentAt = firstNonEmpty(
      rawMessage.published_at,
      rawMessage.sent_at,
      rawMessage.created_at,
    );
    const id = firstNonEmpty(rawMessage.id, rawMessage.message_id);
    if (!id || !sentAt) return null;

    return {
      id: String(id),
      member_id: String(firstNonEmpty(rawMessage.member_id, rawMessage.memberId, group.id)),
      member_name: memberName,
      member_avatar_url: firstNonEmpty(rawMessage.member_avatar_url, rawMessage.avatar, group.thumbnail),
      phone_image_url: firstNonEmpty(rawMessage.phone_image_url, rawMessage.phone_image, group.phone_image),
      type,
      text: firstNonEmpty(rawMessage.text, rawMessage.message),
      media_url: firstNonEmpty(rawMessage.file, rawMessage.media_url, rawMessage.url),
      thumbnail_url: firstNonEmpty(rawMessage.thumbnail, rawMessage.thumbnail_url),
      duration_seconds: firstNonEmpty(rawMessage.duration_seconds, rawMessage.duration),
      sent_at: sentAt,
      incoming_call_from: type === 'audio' && !rawMessage.is_silent ? memberName : null,
      ringtone_url: firstNonEmpty(rawMessage.ringtone_url, rawMessage.notification_sound_android),
      is_played: false,
      original_data: rawMessage,
    };
  }

  async processMessage(message, sendPush) {
    try {
      const result = await this.messageStore.saveMessage(message);
      if (!result.isNew || !sendPush) {
        return { isNew: result.isNew, pushed: false, processed: true };
      }

      try {
        const pushResult = await this.pusher.smartPush(result.message || message);
        return {
          isNew: true,
          pushed: pushResult?.success !== false,
          processed: true,
        };
      } catch (error) {
        await recordError('monitor.push', error, { message_id: message.id, member_id: message.member_id });
        return { isNew: true, pushed: false, processed: true };
      }
    } catch (error) {
      await recordError('monitor.store', error, {
        message_id: message.id,
        member_id: message.member_id,
        member_name: message.member_name,
        type: message.type,
        sent_at: message.sent_at,
      });
      return { isNew: false, pushed: false, processed: false };
    }
  }

  async poll() {
    const groups = await this.resolveGroups();
    if (groups.length === 0) throw new Error('No active subscribed groups found');

    const sendPush = this.hasCompletedInitialPoll || !this.backfillOnStart;
    let fetched = 0;
    let stored = 0;
    let pushed = 0;

    for (const group of groups) {
      const rawMessages = await this.fetchTimeline(group.id);
      const previousIds = this.groupMessageIds.get(group.id) || new Set();
      const currentIds = new Set(rawMessages.map(rawMessage => String(rawMessage.id ?? rawMessage.message_id)));
      const newMessages = rawMessages.filter(rawMessage => !previousIds.has(String(rawMessage.id ?? rawMessage.message_id)));
      const failedIds = new Set();
      fetched += newMessages.length;
      for (const rawMessage of newMessages.reverse()) {
        const rawId = String(rawMessage.id ?? rawMessage.message_id);
        const message = this.normalizeMessage(rawMessage, group);
        if (!message) {
          previousIds.add(rawId);
          continue;
        }
        const result = await this.processMessage(message, sendPush);
        stored += result.isNew ? 1 : 0;
        pushed += result.pushed ? 1 : 0;
        if (result.processed) previousIds.add(rawId);
        else failedIds.add(rawId);
      }
      this.groupMessageIds.set(
        group.id,
        new Set([...currentIds].filter(id => !failedIds.has(id))),
      );
    }

    this.hasCompletedInitialPoll = true;
    console.log(`Nogi monitor poll complete: groups=${groups.length}, fetched=${fetched}, stored=${stored}, pushed=${pushed}`);
  }
}

const monitor = new NogiWebMonitor();

export { NogiWebMonitor };
export default monitor;

if (import.meta.url === `file://${process.argv[1]}`) {
  monitor.start().catch(error => {
    void recordError('monitor.start', error);
    process.exitCode = 1;
  });

  const shutdown = async () => {
    await monitor.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
