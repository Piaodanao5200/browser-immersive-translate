/**
 * 找出「译文莫名其妙单独冒出来一行」的元凶：node tools/dbg-dup.mjs <url>
 * 打印每个译文节点的父元素（标签/类/尺寸/是否 sr-only），以及它是否为装饰性小盒子里的文字。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = path.resolve(import.meta.dirname, '..');
const PORT = 9558;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'https://blog.google/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
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
async function waitFor(fn, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('timeout');
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dup-'));
const browser = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--disable-sync',
    '--disable-features=msEdgeIdentityFeature,msSyncConsent',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
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
  await sleep(4000);

  const swT = await waitFor(async () =>
    (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'))
  );
  const sw = await cdp(swT.webSocketDebuggerUrl);
  const tab = await evalOn(sw, `(async () => {
    const t = await chrome.tabs.query({});
    const p = t.find((x) => (x.url || '').startsWith('http'));
    return p ? { id: p.id, url: p.url } : null;
  })()`);
  await waitFor(async () =>
    evalOn(sw, `(async () => { try { return !!(await chrome.tabs.sendMessage(${tab.id}, { type: 'state' })); } catch (e) { return false; } })()`)
  );
  await evalOn(sw, `(async () => { await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: true }); })()`);
  await sleep(12000);

  const rows = await evalOn(
    page,
    `(() => {
      const out = [];
      const norm = (x) => String(x || '').replace(/\\s+/g, ' ').trim();
      for (const n of document.querySelectorAll('[data-st-tr]')) {
        const p = n.parentElement;
        if (!p) continue;
        const cls = String(n.className || '');
        const t = norm(n.textContent);
        // 结构可疑 1：块级译文挂在了 a / button 这类控件里
        const inControl = !!p.closest('a,button,[role="button"]');
        // 结构可疑 2：附近有同文本的内联译文（同一句话翻了两遍）
        let twin = null;
        let a = p;
        for (let i = 0; i < 4 && a; i++, a = a.parentElement) {
          for (const other of a.querySelectorAll('[data-st-tr]')) {
            if (other !== n && norm(other.textContent) === t && t) { twin = String(other.className || ''); break; }
          }
          if (twin) break;
        }
        if (!inControl && !twin) continue;
        out.push({
          tr: t.slice(0, 24),
          cls,
          inControl,
          twin,
          tag: p.tagName.toLowerCase(),
          pcls: String(p.className || '').slice(0, 40),
          html: p.outerHTML.replace(/\\s+/g, ' ').slice(0, 300)
        });
      }
      return out.slice(0, 14);
    })()`
  );
  console.log(`\n[${url}] 结构可疑译文 ${rows.length} 个：`);
  rows.forEach((r) => {
    console.log(`  - 「${r.tr}」 cls=${r.cls} inControl=${r.inControl} twin=${r.twin} <- ${r.tag}.${r.pcls}`);
    console.log(`    ${r.html}`);
  });

  page.ws.close();
  sw.ws.close();
} catch (e) {
  console.log('失败:', e.message);
} finally {
  browser.kill('SIGKILL');
  await sleep(400);
}
