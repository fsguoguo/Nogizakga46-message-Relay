import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import messageService from '../services/message.js';
import pushService from '../services/push.js';
import { NogiWebMonitor } from './nogi-web.js';
import { recordError } from '../services/error-log.js';

dotenv.config();

const DEFAULT_API_URL = 'https://api.message.nogizaka46.com';
const DEFAULT_WEB_URL = 'https://message.nogizaka46.com';
const DEFAULT_APP_ID = 'jp.co.sonymusic.communication.nogizaka 2.5';
const DEFAULT_PLATFORM = 'web';
const DEFAULT_ORGANIZATION_ID = '1';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MESSAGE_COUNT = 200;
const DEFAULT_BROWSER_STATE_FILE = '/data/nogi-browser-state.json';
const DEFAULT_FRONTEND_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_BROWSER_RESTART_INTERVAL_MS = 30 * 60 * 1000;

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

function browserExecutablePath() {
  return process.env.NOGI_BROWSER_EXECUTABLE_PATH
    || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || undefined;
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

/**
 * Uses the official web app as the authentication client. The page owns the
 * refresh-token flow; this worker only observes the short-lived access token
 * on ordinary API requests and keeps it in memory for timeline polling.
 */
class NogiBrowserMonitor {
  constructor({ browserType = chromium, messageStore = messageService, pusher = pushService } = {}) {
    this.browserType = browserType;
    this.messageStore = messageStore;
    this.pusher = pusher;
    this.apiUrl = (process.env.NOGI_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
    this.webUrl = (process.env.NOGI_WEB_URL || DEFAULT_WEB_URL).replace(/\/$/, '');
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
    this.pageSettleMs = Math.max(
      Number.parseInt(process.env.NOGI_BROWSER_SETTLE_SECONDS || '8', 10) * 1000,
      2_000,
    );
    this.authorizationWaitMs = Math.max(
      Number.parseInt(process.env.NOGI_BROWSER_AUTH_WAIT_SECONDS || '30', 10) * 1000,
      10_000,
    );
    this.requestTimeoutMs = Math.max(
      Number.parseInt(process.env.NOGI_BROWSER_REQUEST_TIMEOUT_SECONDS || '30', 10) * 1000,
      10_000,
    );
    this.frontendRefreshIntervalMs = Math.max(
      Number.parseInt(process.env.NOGI_BROWSER_SESSION_REFRESH_INTERVAL_MINUTES || '30', 10) * 60_000,
      5 * 60_000,
    ) || DEFAULT_FRONTEND_REFRESH_INTERVAL_MS;
    this.browserRestartIntervalMs = Math.max(
      Number.parseInt(process.env.NOGI_BROWSER_RESTART_INTERVAL_SECONDS || '1800', 10) * 1000,
      5 * 60_000,
    ) || DEFAULT_BROWSER_RESTART_INTERVAL_MS;
    this.backfillOnStart = parseBoolean(process.env.NOGI_BACKFILL_ON_START, true);
    this.headless = parseBoolean(process.env.NOGI_BROWSER_HEADLESS, true);
    this.blockPageMedia = parseBoolean(process.env.NOGI_BROWSER_BLOCK_MEDIA, true);
    this.storageStateFile = process.env.NOGI_BROWSER_STATE_FILE || DEFAULT_BROWSER_STATE_FILE;
    this.accessTokenStateFile = process.env.NOGI_ACCESS_TOKEN_STATE_FILE
      || path.join(path.dirname(this.storageStateFile), 'nogi-access-token.json');
    this.pageUrl = `${this.webUrl}/organization/${encodeURIComponent(this.organizationId)}/talk?mode=normal`;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.browserStartedAt = 0;
    this.lastFrontendNavigationAt = 0;
    this.statePersistTimer = null;
    this.statePersistPromise = Promise.resolve();
    this.accessTokenWaiters = new Set();
    this.refreshPromise = null;
    this.loopPromise = null;
    this.isRunning = false;
    this.accessToken = '';
    this.observedTokenAt = 0;
    this.lastPersistedAccessToken = '';
    this.hasCompletedInitialPoll = false;
    this.groupMessageIds = new Map();
    this.groups = new Map();
    this.normalizer = new NogiWebMonitor({ messageStore, pusher });
  }

  async start() {
    if (this.isRunning) return this.loopPromise;

    try {
      await this.openBrowser();
    } catch (error) {
      await this.closeBrowser();
      throw error;
    }

    this.isRunning = true;
    this.loopPromise = this.runLoop();
    return this.loopPromise;
  }

  async runLoop() {
    try {
      while (this.isRunning) {
        try {
          if (!this.page || this.page.isClosed()) await this.openBrowser();
          if (this.shouldRestartBrowser()) await this.restartBrowser();
          if (this.shouldRefreshFrontendSession()) await this.refreshFrontendSession();
          await this.poll();
      } catch (error) {
          await recordError('monitor.poll', error, {
            mode: 'browser',
            has_access_token: Boolean(this.accessToken),
            browser_started_at: this.browserStartedAt || null,
          });
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
    await this.closeBrowser();
  }

  async openBrowser() {
    await this.closeBrowser();
    try {
      const storageState = await this.loadStorageState();
      const persistedAccessToken = await this.loadAccessTokenState();
      const executablePath = browserExecutablePath();
      this.browser = await this.browserType.launch({
        headless: this.headless,
        channel: executablePath
          ? undefined
          : process.env.NOGI_BROWSER_CHANNEL || (this.headless ? 'chromium-headless-shell' : undefined),
        executablePath,
        timeout: 60_000,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      });
      this.context = await this.browser.newContext(storageState ? { storageState } : {});
      this.page = this.context.pages()[0] || await this.context.newPage();
      if (persistedAccessToken) {
        this.accessToken = persistedAccessToken;
        this.observedTokenAt = Date.now();
        this.lastFrontendNavigationAt = Date.now();
      }
      this.page.on('request', request => this.observeRequest(request));
      this.page.on('response', response => this.observeResponse(response));
      if (this.blockPageMedia) {
        await this.page.route('**/*', route => {
          const resourceType = route.request().resourceType();
          if (['image', 'media', 'font'].includes(resourceType)) {
            return route.abort().catch(() => {});
          }
          return route.continue().catch(() => {});
        });
      }
      this.browserStartedAt = Date.now();
    } catch (error) {
      await this.closeBrowser();
      throw error;
    }
  }

  async closeBrowser() {
    if (this.statePersistTimer) {
      clearTimeout(this.statePersistTimer);
      this.statePersistTimer = null;
    }
    await this.statePersistPromise.catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
    this.page = null;
    this.browserStartedAt = 0;
    this.lastFrontendNavigationAt = 0;
    this.accessToken = '';
    this.observedTokenAt = 0;
    for (const waiter of this.accessTokenWaiters) waiter.reject(new Error('浏览器上下文已关闭'));
    this.accessTokenWaiters.clear();
  }

  shouldRestartBrowser() {
    return this.browserStartedAt > 0 && Date.now() - this.browserStartedAt >= this.browserRestartIntervalMs;
  }

  shouldRefreshFrontendSession() {
    return !this.accessToken
      || !this.lastFrontendNavigationAt
      || Date.now() - this.lastFrontendNavigationAt >= this.frontendRefreshIntervalMs;
  }

  async restartBrowser() {
    console.log('Nogi browser monitor restarting browser context to release memory');
    await this.closeBrowser();
    if (this.isRunning) await this.openBrowser();
  }

  observeRequest(request) {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== new URL(this.apiUrl).origin) return;

    const authorization = request.headers().authorization || '';
    if (!authorization.toLowerCase().startsWith('bearer ')) return;
    const token = authorization.slice(7).trim();
    if (!token) return;
    this.accessToken = token;
    this.observedTokenAt = Date.now();
    void this.persistAccessToken();
    for (const waiter of this.accessTokenWaiters) waiter.resolve(token);
    this.accessTokenWaiters.clear();
  }

  waitForAccessToken() {
    if (this.accessToken) return Promise.resolve(this.accessToken);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.accessTokenWaiters.delete(waiter);
        reject(new Error('官网页面没有发出带 Authorization 的 API 请求，请先在浏览器会话中登录'));
      }, this.authorizationWaitMs);
      const waiter = {
        resolve: token => {
          clearTimeout(timer);
          resolve(token);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.accessTokenWaiters.add(waiter);
    });
  }

  observeResponse(response) {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== new URL(this.apiUrl).origin || url.pathname !== '/v2/update_token') return;
    if (response.status() !== 200) return;

    // The refresh response updates IndexedDB asynchronously. Give the page a
    // moment to commit the new refresh token, then persist the browser state.
    if (this.statePersistTimer) clearTimeout(this.statePersistTimer);
    this.statePersistTimer = setTimeout(() => {
      this.statePersistTimer = null;
      this.persistStorageState().catch(error => {
        console.warn('Nogi browser state could not be persisted after token refresh:', error.message);
      });
    }, 250);
  }

  async refreshFrontendSession() {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      const previousToken = this.accessToken;
      const previousObservedTokenAt = this.observedTokenAt;
      // A failed navigation must not make an old token look like a fresh
      // session or overwrite the last known-good storage state.
      this.accessToken = '';
      this.observedTokenAt = 0;
      try {
        // Flutter keeps long-lived resources open, so waiting for
        // `domcontentloaded` can stall the worker indefinitely. `commit` is
        // enough to start the app; the bounded settle period below lets its
        // TokenManager finish the normal API calls.
        await this.page.goto(this.pageUrl, { waitUntil: 'commit', timeout: 30_000 });
        await this.waitForAccessToken();
        await this.page.waitForTimeout(this.pageSettleMs);
        this.lastFrontendNavigationAt = Date.now();
        if (previousToken && previousToken !== this.accessToken) {
          console.log('Nogi browser session supplied a refreshed access token');
        }
        await this.persistStorageState();
        await this.persistAccessToken();
      } catch (error) {
        this.accessToken = previousToken;
        this.observedTokenAt = previousObservedTokenAt;
        throw error;
      }
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  headers() {
    if (!this.accessToken) throw new Error('官网页面尚未提供访问令牌');
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Talk-App-ID': this.appId,
      'X-Talk-App-Platform': this.platform,
      'Accept-Language': process.env.NOGI_ACCEPT_LANGUAGE || 'zh-CN,en-US,ja',
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  async apiRequest(pathname, { retryAuth = true } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await fetch(`${this.apiUrl}${pathname}`, {
        headers: this.headers(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 && retryAuth) {
      await this.refreshFrontendSession();
      return this.apiRequest(pathname, { retryAuth: false });
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
      throw new Error(`Nogi API ${response.status} ${pathname}${detail ? `: ${detail}` : ''}`);
    }
    return payload;
  }

  async resolveGroups() {
    if (this.groupIds.length > 0) {
      return this.groupIds.map(id => ({ id, name: '', phone_image: null, thumbnail: null }));
    }

    const groups = await this.apiRequest(`/v2/groups?organization_id=${encodeURIComponent(this.organizationId)}`);
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
    const payload = await this.apiRequest(`/v2/groups/${encodeURIComponent(groupId)}/timeline?${query}`);
    if (!payload || !Array.isArray(payload.messages)) {
      throw new Error(`Nogi API timeline response for group ${groupId} is invalid`);
    }
    return payload.messages;
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
        const message = this.normalizer.normalizeMessage(rawMessage, group);
        if (!message) {
          previousIds.add(rawId);
          continue;
        }
        const result = await this.normalizer.processMessage(message, sendPush);
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
    await this.persistStorageState();
    console.log(`Nogi browser monitor poll complete: groups=${groups.length}, fetched=${fetched}, stored=${stored}, pushed=${pushed}`);
  }

  async loadStorageState() {
    try {
      const content = await fs.readFile(this.storageStateFile, 'utf8');
      const state = JSON.parse(content);
      if (!state || typeof state !== 'object') throw new Error('invalid browser storage state');
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Nogi browser state could not be loaded:', error.message);
      return null;
    }
  }

  async loadAccessTokenState() {
    try {
      const state = JSON.parse(await fs.readFile(this.accessTokenStateFile, 'utf8'));
      const token = String(state.accessToken || '').trim();
      const expiresAt = tokenExpiry(token);
      if (!token || (expiresAt && expiresAt.getTime() <= Date.now() + 30_000)) return '';
      return token;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Nogi access token state could not be loaded:', error.message);
      return '';
    }
  }

  async persistAccessToken() {
    if (!this.accessToken || this.accessToken === this.lastPersistedAccessToken) return;
    const token = this.accessToken;
    this.lastPersistedAccessToken = token;
    try {
      const directory = path.dirname(this.accessTokenStateFile);
      await fs.mkdir(directory, { recursive: true });
      const tempFile = `${this.accessTokenStateFile}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tempFile, JSON.stringify({
        accessToken: token,
        savedAt: Date.now(),
      }), { mode: 0o600 });
      await fs.rename(tempFile, this.accessTokenStateFile);
    } catch (error) {
      if (this.lastPersistedAccessToken === token) this.lastPersistedAccessToken = '';
      console.warn('Nogi access token state could not be persisted:', error.message);
    }
  }

  async persistStorageState() {
    if (!this.context) return this.statePersistPromise;

    const persist = async () => {
      if (!this.context) return;
      try {
        const state = await this.context.storageState({ indexedDB: true });
        const directory = path.dirname(this.storageStateFile);
        await fs.mkdir(directory, { recursive: true });
        const tempFile = `${this.storageStateFile}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tempFile, JSON.stringify(state), { mode: 0o600 });
        await fs.rename(tempFile, this.storageStateFile);
      } catch (error) {
        console.warn('Nogi browser state could not be persisted:', error.message);
      }
    };

    this.statePersistPromise = this.statePersistPromise.then(persist, persist);
    return this.statePersistPromise;
  }
}

const monitor = new NogiBrowserMonitor();

export { NogiBrowserMonitor };
export default monitor;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: mediaServer } = await import('./media-server.js');
  mediaServer.start().then(() => monitor.start()).catch(error => {
    void recordError('monitor.start', error);
    process.exitCode = 1;
  });

  const shutdown = async () => {
    await monitor.stop();
    await mediaServer.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
