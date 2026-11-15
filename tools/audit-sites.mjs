/**
 * 多站点漏译巡检
 *   node tools/audit-sites.mjs [额外网址...]
 *   ONLY=blog-google,wikipedia node tools/audit-sites.mjs
 *
 * 对每个站点：打开 → 开启翻译 → 等稳定（含滚动触发懒加载）→ 取诊断快照 → 截图
 *
 * 说明：控制端用的是扩展自己的设置页（扩展页面），而不是 background service worker。
 * MV3 的 service worker 会休眠，休眠后 CDP target 直接消失，用它当控制端会随机失败。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = 'D:/浏览器翻译插件';
const OUT = path.join(EXT, 'test');
const PORT = 9600 + Math.floor(Math.random() * 300);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_SITES = [
  ['blog-google', 'https://blog.google/'],
  ['github-repo', 'https://github.com/microsoft/vscode'],
  ['hacker-news', 'https://news.ycombinator.com/'],
  ['wikipedia', 'https://en.wikipedia.org/wiki/Immersive_translation'],
  ['stackoverflow', 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array'],
  ['python-docs', 'https://docs.python.org/3/tutorial/classes.html'],
  ['react-dev', 'https://react.dev/learn'],
  ['tailwind', 'https://tailwindcss.com/docs/installation']
];

const ENGINE = process.env.ENGINE || 'microsoft';
const LLM_KEY = process.env.LLM_KEY || '';
const ONLY = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const extras = process.argv.slice(2).map((u, i) => ['extra' + i, u]);
const sites = (ONLY.length ? DEFAULT_SITES.filter(([n]) => ONLY.includes(n)) : DEFAULT_SITES).concat(extras);

async function waitFor(fn, timeout = 30000, label = '') {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error('超时 ' + label + (lastErr ? ' :: ' + lastErr.message : ''));
}

const targets = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
  return r.json();
};

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws 连接失败'));
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

async function evalOn(c, expr, ms = 25000) {
  const r = await Promise.race([
    c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('求值超时: ' + expr.slice(0, 50))), ms))
  ]);
  if (!r) throw new Error('求值无响应');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-audit-'));
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

const report = [];
const PAGE_STATE = `(() => ({ total: document.querySelectorAll('[data-st-tr]').length, loading: document.querySelectorAll('[data-st-tr].st-loading').length, err: document.querySelectorAll('[data-st-tr].st-error').length }))()`;

try {
  console.log('启动浏览器，端口', PORT);
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).ok,
    40000,
    'browser'
  );

  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
  const browserCdp = await cdp(ver.webSocketDebuggerUrl);

  const pageT = await waitFor(async () => (await targets()).find((t) => t.type === 'page'), 20000, 'page');
  const page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  // 扩展 ID：同一个目录在同一台机器上固定，从任意扩展 target 的 URL 里取
  const extT = await waitFor(
    async () =>
      (await targets()).find((t) => t.url.startsWith('chrome-extension://') && t.url.includes('/src/background.js')) ||
      (await targets()).find((t) => t.url.startsWith('chrome-extension://')),
    30000,
    '扩展'
  );
  const extId = new URL(extT.url).host;
  console.log('扩展 ID:', extId);

  // 控制端：扩展设置页（扩展页面不会像 service worker 那样休眠）
  const created = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
  const ctrlT = await waitFor(async () => (await targets()).find((t) => t.id === created.targetId), 20000, 'ctrl');
  const ctrl = await cdp(ctrlT.webSocketDebuggerUrl);
  await ctrl.send('Runtime.enable');
  const ctrlEval = (expr, ms = 25000) => evalOn(ctrl, expr, ms);

  const env = await waitFor(
    async () => {
      try {
        return await ctrlEval(`(async () => ({ v: chrome.runtime.getManifest().version, s: await chrome.storage.sync.get(null) }))()`, 8000);
      } catch (e) {
        return null;
      }
    },
    15000,
    '控制端就绪'
  );
  console.log('环境:', JSON.stringify(env));

  // 固定成指定引擎，免得账号同步下来的设置影响测量
  await ctrlEval(`(async () => {
    await chrome.storage.sync.set({
      engine: ${JSON.stringify(ENGINE)},
      autoSites: [],
      llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: ${JSON.stringify(LLM_KEY)} }
    });
    return 'forced';
  })()`);

  for (const [name, url] of sites) {
    const rec = { name, url };
    try {
      let loaded = false;
      for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
        await page.send('Page.navigate', { url });
        await sleep(3500);
        const href = await evalOn(page, 'location.href', 8000);
        loaded = !String(href).startsWith('chrome-error');
        if (!loaded) {
          if (attempt === 2) throw new Error('页面加载失败（网络错误页）');
          console.log('   加载失败，重试', attempt + 1);
          await sleep(1500);
        }
      }

      const tab = await waitFor(
        async () =>
          ctrlEval(
            `(async () => {
              const t = await chrome.tabs.query({});
              const p = t.find((x) => (x.url || '').startsWith('http'));
              return p ? { id: p.id, url: p.url } : null;
            })()`,
            10000
          ),
        20000,
        '页面标签'
      );
      rec.finalUrl = tab.url;
      rec.title = await evalOn(page, 'document.title', 8000);

      await waitFor(
        async () =>
          ctrlEval(
            `(async () => {
              try { return !!(await chrome.tabs.sendMessage(${tab.id}, { type: 'state' })); } catch (e) { return false; }
            })()`,
            8000
          ),
        25000,
        '内容脚本'
      );

      await ctrlEval(`(async () => {
        try { await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: false }); } catch (e) {}
        await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: true });
      })()`);

      const t0 = Date.now();
      let last = { total: 0, loading: 0, err: 0 };
      for (let i = 0; i < 150; i++) {
        await sleep(500);
        last = await evalOn(page, PAGE_STATE, 8000);
        if (last.total && !last.loading) break;
      }
      // 滚一遍触发懒加载 / 轮播切页，再等增量翻译
      await evalOn(
        page,
        `(async () => {
          const step = Math.round(innerHeight * 0.8);
          for (let y = 0; y < Math.min(innerHeight * 6, document.body.scrollHeight); y += step) {
            scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 220));
          }
          scrollTo(0, 0);
          return 1;
        })()`,
        30000
      );
      await sleep(3000);
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        last = await evalOn(page, PAGE_STATE, 8000);
        if (!last.loading) break;
      }
      rec.segs = last.total;
      rec.errSegs = last.err;
      rec.ms = Date.now() - t0;

      const diag = await ctrlEval(`(async () => {
        try { return await chrome.tabs.sendMessage(${tab.id}, { type: 'diag' }); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      })()`);
      if (diag && diag.ok) {
        rec.blocks = diag.data.blocks;
        rec.withUnit = diag.data.withUnit;
        rec.dropped = diag.data.dropped;
        rec.run = diag.data.run;
        rec.reasons = diag.data.reasons;
        rec.failedSamples = diag.data.failed || [];
        rec.missed = (diag.data.samples || []).filter((s) => s.reason === 'MISSED').slice(0, 10);
        rec.langSamples = (diag.data.samples || []).filter((s) => s.reason === 'lang').slice(0, 8);
      } else {
        rec.diagError = (diag && diag.error) || 'no diag';
      }

      // 重复译文检测：块级译文的文字，和附近某条内联译文一模一样
      rec.dups = await evalOn(
        page,
        `(() => {
          const out = [];
          for (const n of document.querySelectorAll('.st-tr')) {
            const t = n.textContent.trim();
            if (!t) continue;
            let a = n.parentElement;
            for (let i = 0; i < 4 && a; i++, a = a.parentElement) {
              const inl = [...a.querySelectorAll('.st-tr-inline')].find((x) => x.textContent.trim() === t);
              if (inl) {
                out.push({
                  tr: t,
                  parent: n.parentElement.tagName.toLowerCase() + '.' + String(n.parentElement.className).slice(0, 46),
                  wrapper: a.tagName.toLowerCase() + '.' + String(a.className).slice(0, 46)
                });
                break;
              }
            }
          }
          return out.slice(0, 8);
        })()`,
        12000
      );

      rec.engineLog = await ctrlEval(`(async () => {
        try { return (await chrome.runtime.sendMessage({ type: 'engine-log' })).list.slice(-12); }
        catch (e) { return ['engine-log 失败: ' + String((e && e.message) || e)]; }
      })()`);

      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, 'audit-' + slug(name) + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      rec.shot = file;

      console.log(
        `\n=== ${name} — ${rec.segs} 段 / 失败 ${rec.errSegs} / ${(rec.ms / 1000).toFixed(1)}s  ` +
          `未翻块 ${rec.blocks}，已有译文 ${rec.withUnit}，撤掉 ${rec.dropped}`
      );
      console.log('   收集统计:', JSON.stringify(rec.run));
      if (rec.reasons) console.log('   跳过原因:', JSON.stringify(rec.reasons));
      if (rec.missed && rec.missed.length) {
        console.log('   漏收样例:');
        rec.missed.slice(0, 6).forEach((m) => console.log(`     - ${m.tag}.${m.cls} :: ${m.text}`));
      }
      if (rec.failedSamples && rec.failedSamples.length) {
        console.log('   失败片段样例:');
        rec.failedSamples.slice(0, 5).forEach((f) => console.log(`     - [${f.len}字] ${f.text} :: ${f.err}`));
      }
      if (rec.dups && rec.dups.length) {
        console.log('   重复译文:', rec.dups.length);
        rec.dups.slice(0, 4).forEach((d) => console.log(`     - 「${d.tr}」 in ${d.parent} / 同层 ${d.wrapper}`));
      }
      if (rec.langSamples && rec.langSamples.length) {
        console.log('   判定为无需翻译的样例:');
        rec.langSamples.slice(0, 5).forEach((m) => console.log(`     - ${m.tag}.${m.cls} :: ${m.text}`));
      }
      if (rec.engineLog && rec.engineLog.length) {
        console.log('   引擎错误日志:');
        rec.engineLog.slice(-8).forEach((e) =>
          console.log(`     - ${e.engine} n=${e.n} ${e.chars}字 :: ${e.msg}`)
        );
      }
      if (rec.diagError) console.log('   诊断失败:', rec.diagError);
    } catch (e) {
      rec.error = e.message;
      console.log(`\n=== ${name} 失败: ${e.message}`);
    }
    report.push(rec);
  }

  page.ws.close();
  ctrl.ws.close();
  browserCdp.ws.close();
} catch (e) {
  console.log('致命错误:', e.message);
} finally {
  fs.writeFileSync(path.join(OUT, 'audit-report.json'), JSON.stringify(report, null, 2));
  spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(400);
  console.log('\n报告: test/audit-report.json');
}
