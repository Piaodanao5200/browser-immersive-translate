/**
 * 验证：--load-extension 加载的扩展在浏览器重启后是否仍保留
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve(import.meta.dirname, '..');
const PORT = 9666;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-persist-'));
console.log('临时配置目录:', userDir);

function launch(extra) {
  return spawn(
    EDGE,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...extra,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );
}

async function extensionsInProfile() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.filter((t) => t.type === 'service_worker' || t.type === 'background_page').map((t) => t.url);
}

// 第一轮：带 --load-extension
let b = launch([`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`]);
await sleep(6000);
const first = await extensionsInProfile();
console.log('第一次启动（带加载参数）：', first.filter((u) => u.includes('/src/')).join(' | ') || '（没找到自己的扩展）');
b.kill('SIGKILL');
await sleep(2500);

// 检查 profile 里的 Preferences 是否写入了扩展记录
const prefPath = path.join(userDir, 'Default', 'Preferences');
let prefHit = 'no-preferences';
if (fs.existsSync(prefPath)) {
  const raw = fs.readFileSync(prefPath, 'utf8');
  prefHit = raw.includes('ehnnohlfcnokpmmmncebjajghkpakhpe') ? 'FOUND-IN-PREFS' : 'not-in-prefs';
}
console.log('Preferences 中的扩展记录:', prefHit);

// 第二轮：不带参数重启
b = launch([]);
await sleep(6000);
const second = await extensionsInProfile();
const mine = second.filter((u) => u.includes('/src/background.js'));
console.log('第二次启动（不带参数）：', mine.length ? '扩展仍在 → ' + mine[0] : '扩展已消失（未持久化）');
b.kill('SIGKILL');
await sleep(800);
