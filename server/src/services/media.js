import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { recordError } from './error-log.js';

const DEFAULT_STORAGE_DIR = '/app/nogi-media';
const MAX_MEDIA_BYTES = Number.parseInt(process.env.MEDIA_MAX_BYTES || `${100 * 1024 * 1024}`, 10);

function safePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'unknown';
}

function extensionFor(url, kind, type) {
  try {
    const extension = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(extension)) return extension;
  } catch {
    // Fall through to a type-based extension.
  }

  if (kind === 'thumbnail' || kind === 'phone_image') return 'jpg';
  return { image: 'jpg', audio: 'm4a', video: 'mp4' }[type] || 'bin';
}

class MediaArchive {
  constructor({ fetchImpl = globalThis.fetch, storageDir = process.env.MEDIA_STORAGE_DIR || DEFAULT_STORAGE_DIR } = {}) {
    this.fetchImpl = fetchImpl;
    this.storageDir = path.resolve(storageDir);
  }

  async ensureStorage() {
    await fsp.mkdir(this.storageDir, { recursive: true });
  }

  async download(url, targetPath) {
    if (!url || !url.startsWith('https://')) throw new Error('media URL must use HTTPS');
    await this.ensureStorage();

    try {
      const stat = await fsp.stat(targetPath);
      if (stat.isFile() && stat.size > 0) return targetPath;
    } catch {
      // The file does not exist yet.
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    const tempPath = `${targetPath}.part-${process.pid}-${Date.now()}`;
    let output;
    try {
      const response = await this.fetchImpl(url, { redirect: 'follow', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`media download returned HTTP ${response.status}`);

      const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) {
        throw new Error(`media exceeds ${MAX_MEDIA_BYTES} byte limit`);
      }

      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      output = fs.createWriteStream(tempPath, { flags: 'wx' });
      const reader = response.body.getReader();
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_MEDIA_BYTES) throw new Error(`media exceeds ${MAX_MEDIA_BYTES} byte limit`);
          if (!output.write(Buffer.from(value))) await once(output, 'drain');
        }
      } finally {
        reader.releaseLock();
      }
      output.end();
      await once(output, 'finish');
      await fsp.rename(tempPath, targetPath);
      return targetPath;
    } catch (error) {
      output?.destroy();
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async archiveMessage(message) {
    const result = { mediaLocalPath: null, thumbnailLocalPath: null, phoneImageLocalPath: null };
    if (!message) return result;

    const messageDir = path.join(this.storageDir, safePart(message.id));
    if (message.type !== 'text' && message.media_url) {
      const extension = extensionFor(message.media_url, 'media', message.type);
      const target = path.join(messageDir, `media.${extension}`);
      try {
        result.mediaLocalPath = await this.download(message.media_url, target);
      } catch (error) {
        await recordError('media.archive', error, { message_id: message.id, kind: 'media', url: message.media_url });
      }
    }
    if (message.type !== 'text' && message.thumbnail_url) {
      const extension = extensionFor(message.thumbnail_url, 'thumbnail', message.type);
      const target = path.join(messageDir, `thumbnail.${extension}`);
      try {
        result.thumbnailLocalPath = await this.download(message.thumbnail_url, target);
      } catch (error) {
        await recordError('media.archive', error, { message_id: message.id, kind: 'thumbnail', url: message.thumbnail_url });
      }
    }
    if (message.type === 'audio' && message.incoming_call_from && message.phone_image_url) {
      const extension = extensionFor(message.phone_image_url, 'phone_image', 'image');
      const target = path.join(messageDir, `phone_image.${extension}`);
      try {
        result.phoneImageLocalPath = await this.download(message.phone_image_url, target);
      } catch (error) {
        await recordError('media.archive', error, { message_id: message.id, kind: 'phone_image', url: message.phone_image_url });
      }
    }
    return result;
  }

  publicUrl(messageId, kind = 'media') {
    const baseUrl = (
      process.env.PUBLIC_MEDIA_BASE_URL
      || process.env.PUBLIC_BASE_URL
      || 'https://nogi-relay.fly.dev'
    ).replace(/\/$/, '');
    return `${baseUrl}/v1/messages/${encodeURIComponent(messageId)}/media/${kind}`;
  }

  isSafeStoredPath(filePath) {
    if (!filePath) return false;
    const relative = path.relative(this.storageDir, path.resolve(filePath));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  async storedFile(filePath) {
    if (!this.isSafeStoredPath(filePath)) return null;
    try {
      const stat = await fsp.stat(filePath);
      return stat.isFile() && stat.size > 0 ? filePath : null;
    } catch {
      return null;
    }
  }
}

const mediaArchive = new MediaArchive();

export { MediaArchive };
export default mediaArchive;
