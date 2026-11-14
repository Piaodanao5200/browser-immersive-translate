/**
 * 把扩展安装进真实浏览器配置（一次启动写入，之后永久保留）
 * 用法：node tools/install-extension.mjs edge|ego
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = 'D:\\浏览器翻译插件';
const EXT_ID = 'ehnnohlfcnokpmmmncebjajghkpakhpe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = {
  edge: {
    name: 'Microsoft Edge',
    exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    procs: ['msedge.exe'],
    pref: path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Preferences')
  },
  ego: {
    name: 'ego lite',
    exe: 'C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe',
    procs: ['ego.exe'],
    pref: path.join(process.env.LOCALAPPDATA, 'Citro Labs', 'ego lite', 'User Data', 'Profile 1', 'Preferences')
  }
};

const which = process.argv[2];
const t = TARGETS[which];
if (!t) {
  console.log('用法: node tools/install-extension.mjs edge|ego');
  process.exit(1);
}

function running(names) {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
    return names.some((n) => out.toLowerCase().includes('"' + n.toLowerCase() + '"'));
  } catch (e) {
    return false;
  }
}

function closeGracefully(names) {
  // 不带 /F：向窗口发送关闭消息，浏览器会正常落盘会话，重开可恢复标签页
  for (const n of names) {
    try {
      execSync(`taskkill /IM ${n}`, { stdio: 'ignore' });
    } catch (e) {
      /* 进程可能已退出 */
    }
  }
}

function checkInstalled() {
  const dir = path.dirname(t.pref);
  const candidates = [path.join(dir, 'Secure Preferences'), path.join(dir, 'Preferences')];
  const found = { ok: false, reason: '配置里没有扩展记录' };
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      continue;
    }
    const entry = json.extensions && json.extensions.settings && json.extensions.settings[EXT_ID];
    if (!entry) continue;
    const reasons = entry.disable_reasons || [];
    return {
      ok: true,
      disabled: reasons.length > 0,
      reasons: reasons,
      path: entry.path,
      location: entry.location,
      file: path.basename(f)
    };
  }
  return found;
}

console.log(`== 安装到 ${t.name} ==`);

if (running(t.procs)) {
  console.log('  1) 正在关闭浏览器…');
  closeGracefully(t.procs);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (!running(t.procs)) break;
  }
  if (running(t.procs)) {
    console.log('  ! 未能正常关闭（可能有“确认关闭”弹窗），改为强制结束');
    for (const n of t.procs) {
      try {
        execSync(`taskkill /F /IM ${n}`, { stdio: 'ignore' });
      } catch (e) {}
    }
    await sleep(2500);
  }
  console.log('  浏览器已退出');
} else {
  console.log('  1) 浏览器未在运行');
}

console.log('  2) 带扩展参数启动并写入配置…');
const child = spawn(t.exe, [`--load-extension=${EXT_DIR}`, '--restore-last-session'], {
  detached: true,
  stdio: 'ignore'
});
child.unref();

await sleep(6000);

let result = checkInstalled();
if (!result.ok) {
  await sleep(6000);
  result = checkInstalled();
}

if (result.ok) {
  console.log('  ✅ 已写入配置');
  console.log('     路径:', result.path);
  console.log('     文件:', result.file, '| location:', result.location);
  if (result.disabled) {
    console.log('     ⚠️  状态：已停用，disable_reasons =', result.reasons.join(','));
  } else {
    console.log('     状态：已启用');
  }
} else {
  console.log('  ❌ 未写入：' + result.reason);
}
