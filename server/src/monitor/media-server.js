import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import messageService from '../services/message.js';

const DEFAULT_PORT = 8081;
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function bearerToken(request) {
  const value = request.headers.authorization || '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

class NogiMediaServer {
  constructor({ port = Number.parseInt(process.env.NOGI_MEDIA_PORT || `${DEFAULT_PORT}`, 10) } = {}) {
    this.port = Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
    this.server = null;
  }

  async start() {
    if (this.server) return;
    if (!process.env.ACCESS_TOKEN) {
      throw new Error('ACCESS_TOKEN is required for the monitor media server');
    }

    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(error => {
        console.error('Nogi media server request failed:', error.message);
        if (!response.headersSent) sendJson(response, 500, { error: 'Media server failure' });
        else response.destroy();
      });
    });

    await new Promise((resolve, reject) => {
      const onError = error => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, '0.0.0.0');
    });
    console.log(`Nogi media server listening on port ${this.port}`);
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise(resolve => server.close(() => resolve()));
  }

  async handle(request, response) {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, { status: 'ok' });
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return sendJson(response, 405, { error: 'Method not allowed' });
    }
    if (bearerToken(request) !== process.env.ACCESS_TOKEN) {
      return sendJson(response, 401, { error: 'Unauthorized' });
    }

    const parsed = new URL(request.url, 'http://127.0.0.1');
    const match = parsed.pathname.match(/^\/v1\/messages\/([^/]+)\/media\/(media|thumbnail)$/);
    if (!match) return sendJson(response, 404, { error: 'Not found' });

    const messageId = decodeURIComponent(match[1]);
    const kind = match[2];
    const filePath = await messageService.getStoredMediaPath(messageId, kind);
    if (!filePath) return sendJson(response, 404, { error: 'Media not archived' });

    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return sendJson(response, 404, { error: 'Media not archived' });

    const extension = path.extname(filePath).slice(1).toLowerCase();
    response.statusCode = 200;
    response.setHeader('Cache-Control', 'private, max-age=86400');
    response.setHeader('Content-Type', MIME_BY_EXTENSION[extension] || 'application/octet-stream');
    response.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(filePath).on('error', error => {
      console.error('Nogi media stream failed:', error.message);
      response.destroy(error);
    }).pipe(response);
  }
}

const mediaServer = new NogiMediaServer();

export { NogiMediaServer };
export default mediaServer;
