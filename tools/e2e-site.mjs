/**
 * 真实站点压测：node tools/e2e-site.mjs <url> [等待秒数]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
const waitSec = Number(process.argv[3] || 12);
const PORT = 9555;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'D:/浏览器翻译插件/test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('超时');
}

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  return {
    ws,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      })
  };
}

async function evalOn(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-site-'));
const browser = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    '--load-extension=D:/浏览器翻译插件',
    '--disable-extensions-except=D:/浏览器翻译插件',
    '--disable-sync',
    '--disable-features=msEdgeIdentityFeature,msSyncConsent',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const pageT = await waitFor(async () => (await targets()).find((t) => t.type === 'page'));
  const page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url });
  await sleep(5000);

  const swT = await waitFor(async () =>
    (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'))
  );
  const sw = await cdp(swT.webSocketDebuggerUrl);
  const tab = await evalOn(sw, `(async () => { const t = await chrome.tabs.query({}); return t.map((x) => ({ id: x.id, url: x.url })); })()`);
  const target = tab.find((t) => (t.url || '').startsWith('http')) || tab[0];
  console.log('页面:', target.url);

  const t0 = Date.now();
  await evalOn(sw, `(async () => await chrome.tabs.sendMessage(${target.id}, { type: 'set-enabled', enabled: true }))()`);

  let last = null;
  for (let i = 0; i < Math.ceil((waitSec * 1000) / 800); i++) {
    await sleep(800);
    last = await evalOn(
      page,
      `(() => ({ total: document.querySelectorAll('[data-st-tr]').length, loading: document.querySelectorAll('[data-st-tr].st-loading').length, err: document.querySelectorAll('[data-st-tr].st-error').length }))()`
    );
    if (last.total > 0 && last.loading === 0) break;
  }
  console.log('结果:', JSON.stringify(last), '耗时', Date.now() - t0, 'ms');

  const quality = await evalOn(
    page,
    `(() => {
      const all = [...document.querySelectorAll('[data-st-tr]')];
      const text = all.map((n) => n.textContent).join(' ');
      const zh = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
      const en = (text.match(/[A-Za-z]/g) || []).length;
      const inside = document.querySelectorAll('pre [data-st-tr], code [data-st-tr], input [data-st-tr]').length;
      return { segs: all.length, zhRatio: +(zh / Math.max(1, zh + en)).toFixed(3), badInsideCode: inside };
    })()`
  );
  console.log('质量:', JSON.stringify(quality));

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'shot-site.png'), Buffer.from(shot.data, 'base64'));
  page.ws.close();
  sw.ws.close();
} catch (e) {
  console.log('失败:', e.message);
} finally {
  browser.kill('SIGKILL');
  await sleep(500);
}
