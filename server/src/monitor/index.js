import dotenv from 'dotenv';

dotenv.config();

const browserMode = process.env.NOGI_MONITOR_MODE === 'browser';
const monitor = browserMode
  ? (await import('./nogi-browser.js')).default
  : (await import('./nogi-web.js')).default;
const mediaServer = browserMode ? (await import('./media-server.js')).default : null;

if (mediaServer) await mediaServer.start();

monitor.start().catch(error => {
  console.error('Nogi monitor stopped:', error);
  process.exitCode = 1;
});

const shutdown = async () => {
  await monitor.stop();
  await mediaServer?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
