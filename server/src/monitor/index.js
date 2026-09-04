import dotenv from 'dotenv';
import { recordError } from '../services/error-log.js';

dotenv.config();

const browserMode = process.env.NOGI_MONITOR_MODE === 'browser';
const monitor = browserMode
  ? (await import('./nogi-browser.js')).default
  : (await import('./nogi-web.js')).default;
const mediaServer = browserMode ? (await import('./media-server.js')).default : null;

if (mediaServer) await mediaServer.start();

monitor.start().catch(error => {
  void recordError('monitor.start', error);
  process.exitCode = 1;
});

process.on('uncaughtException', error => {
  void recordError('monitor.uncaught_exception', error).finally(() => process.exit(1));
});
process.on('unhandledRejection', reason => {
  void recordError('monitor.unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

const shutdown = async () => {
  await monitor.stop();
  await mediaServer?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
