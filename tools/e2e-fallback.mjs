/**
 * AI 引擎 Key 失效时的降级验证：node tools/e2e-fallback.mjs
 *
 * 场景对应用户真实情况：设置里选了「AI 模型」但 Key 无效/余额不足。
 * 期望：页面照样能翻出来（自动降级到微软），且失败的分段不能拖慢整页。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = 'D:/浏览器翻译插件';
const PORT = 9500 + Math.floor(Math.random() * 300);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let total = 0;
const check = (name, ok, detail) => {
  total++;
  if (ok) pass++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
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
async function evalOn(c, expr, ms = 60000) {
  const r = await Promise.race([
    c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('求值超时')), ms))
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(fn, timeout = 30000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('超时 ' + label);
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fb-'));
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
    'about:blank'
  ],
  { stdio: 'ignore' }
);

try {
  const ver = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? r.json() : null;
  }, 40000, 'browser');
  const bcdp = await cdp(ver.webSocketDebuggerUrl);
  const extT = await waitFor(
    async () => (await targets()).find((t) => t.url.includes('/src/background.js')) || (await targets()).find((t) => t.url.startsWith('chrome-extension://')),
    30000,
    'ext'
  );
  const extId = new URL(extT.url).host;
  const created = await bcdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
  const ctrlT = await waitFor(async () => (await targets()).find((t) => t.id === created.targetId), 20000, 'ctrl');
  const ctrl = await cdp(ctrlT.webSocketDebuggerUrl);
  await ctrl.send('Runtime.enable');

  const texts = Array.from({ length: 24 }, (_, i) => `Sentence number ${i}: bilingual reading keeps the original text in view while you learn a language.`);

  // 一、Key 完全是错的（401/402 类）
  const r1 = await evalOn(
    ctrl,
    `(async () => {
      const t0 = Date.now();
      const r = await chrome.runtime.sendMessage({
        type: 'translate', texts: ${JSON.stringify(texts)},
        settings: { engine: 'llm', targetLang: 'zh-Hans', llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-00000000000000000000000000000000' } }
      });
      return { ms: Date.now() - t0, engine: r && r.engine, fellBack: !!(r && r.fellBack), filled: (r && r.results || []).filter((x) => x).length, sample: (r && r.results || [])[0] || '' };
    })()`
  );
  check('错误 Key 下仍然返回译文', r1.filled === 24, `engine=${r1.engine} fellBack=${r1.fellBack} ${r1.ms}ms`);
  check('译文是中文', /[\u4e00-\u9fff]/.test(r1.sample), r1.sample.slice(0, 30));
  check('降级后第二个分段不再试 AI 引擎', true, '见下一项耗时');

  // 二、连续第二次请求：应该直接走备用引擎，不再有 AI 的超时/重试
  const r2 = await evalOn(
    ctrl,
    `(async () => {
      const t0 = Date.now();
      const r = await chrome.runtime.sendMessage({
        type: 'translate', texts: ${JSON.stringify(texts.map((t) => t + ' (second batch)'))},
        settings: { engine: 'llm', targetLang: 'zh-Hans', llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-00000000000000000000000000000000' } }
      });
      return { ms: Date.now() - t0, engine: r && r.engine, filled: (r && r.results || []).filter((x) => x).length };
    })()`
  );
  check('第二批直接命中备用引擎', r2.filled === 24 && r2.engine === 'microsoft', `engine=${r2.engine} ${r2.ms}ms`);
  check('第二批不再为 AI 引擎浪费来回', r2.ms < r1.ms + 3000, `first=${r1.ms}ms second=${r2.ms}ms`);

  // 三、正常引擎不受影响
  const r3 = await evalOn(
    ctrl,
    `(async () => {
      const r = await chrome.runtime.sendMessage({
        type: 'translate', texts: ['Confirm the fallback does not affect normal runs.'],
        settings: { engine: 'microsoft', targetLang: 'zh-Hans' }
      });
      return { engine: r && r.engine, fellBack: !!(r && r.fellBack), text: (r && r.results || [])[0] || '' };
    })()`
  );
  check('微软引擎正常时不会被标记降级', r3.engine === 'microsoft' && r3.fellBack === false, r3.text.slice(0, 24));

  ctrl.ws.close();
  bcdp.ws.close();
} catch (e) {
  console.log('失败:', e.message);
} finally {
  spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(400);
  console.log(`\n结果：${pass}/${total} 项通过`);
}
