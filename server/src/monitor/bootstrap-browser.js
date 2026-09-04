import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

dotenv.config();

const webUrl = (process.env.NOGI_WEB_URL || 'https://message.nogizaka46.com').replace(/\/$/, '');
const organizationId = process.env.NOGI_ORGANIZATION_ID || '1';
const stateFile = process.env.NOGI_BROWSER_STATE_FILE || './nogi-browser-state.json';
const executablePath = process.env.NOGI_BROWSER_EXECUTABLE_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : undefined);
const apiOrigin = new URL(process.env.NOGI_API_URL || 'https://api.message.nogizaka46.com').origin;

const state = await loadState(stateFile);
const browser = await chromium.launch({
  headless: false,
  executablePath,
  args: ['--no-sandbox'],
});
const context = await browser.newContext(state ? { storageState: state } : {});
let authorizationObserved = false;
context.on('request', request => {
  try {
    const url = new URL(request.url());
    const authorization = request.headers().authorization || '';
    if (url.origin === apiOrigin && authorization.toLowerCase().startsWith('bearer ')) {
      authorizationObserved = true;
    }
  } catch {
    // Ignore non-HTTP requests.
  }
});
const page = await context.newPage();
const pageUrl = `${webUrl}/organization/${encodeURIComponent(organizationId)}/talk?mode=normal`;

try {
  await page.goto(pageUrl, { waitUntil: 'commit', timeout: 60_000 });
  const terminal = readline.createInterface({ input, output });
  await terminal.question('请在打开的官网窗口中完成登录，确认页面可正常查看消息后按回车保存会话...');
  terminal.close();
  if (!authorizationObserved) {
    throw new Error('未检测到官网授权请求，未保存会话；请确认已登录并能查看消息后重试');
  }

  const savedState = await context.storageState({ indexedDB: true });
  const directory = path.dirname(stateFile);
  await fs.mkdir(directory, { recursive: true });
  const tempFile = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempFile, JSON.stringify(savedState), { mode: 0o600 });
  await fs.rename(tempFile, stateFile);
  console.log(`浏览器会话已保存到 ${path.resolve(stateFile)}（权限 0600）`);
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

async function loadState(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}
