/**
 * Captura por seção: rola até cada seção e fotografa a viewport.
 * Evita o artefato de redimensionar o viewport (que estica区块 com 100svh).
 *
 * Uso: node scripts/shoot.mjs [--url URL] [--width W] [--height H]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const URL_ = arg('--url', 'http://127.0.0.1:4173/');
const W = parseInt(arg('--width', '1440'), 10);
const H = parseInt(arg('--height', '900'), 10);
const OUT_DIR = arg('--out', '/tmp/sec');
const PORT = 9300 + Math.floor(Math.random() * 300);
fs.mkdirSync(OUT_DIR, { recursive: true });

const brave = spawn('/opt/brave-bin/brave', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cdp-shoot-${PORT}`,
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let cdp;
try {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch {}
    if (!page) await sleep(250);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((res, rej) => {
      pending.set(i, { resolve: res, reject: rej });
      setTimeout(() => pending.has(i) && (pending.delete(i), rej(new Error('timeout ' + method))), 25000);
    });
  };
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'erro');
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: W < 500,
  });
  await send('Page.navigate', { url: URL_ });
  await sleep(2500);

  // garante que todos os reveals foram ativados
  await evalJs(`(async () => {
    const html = document.documentElement;
    const prev = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    const S = document.documentElement.scrollHeight;
    for (let y = 0; y < S; y += 250) { window.scrollTo(0, y); await new Promise(r=>setTimeout(r,20)); }
    await new Promise(r=>setTimeout(r,400));
    window.scrollTo(0,0);
    await new Promise(r=>setTimeout(r,300));
    html.style.scrollBehavior = prev;
    return true;
  })()`);
  await sleep(600);

  // seções a fotografar
  const sections = JSON.parse(await evalJs(`JSON.stringify(
    Array.from(document.querySelectorAll('main > section, main > header, footer')).map((s) => ({
      id: s.id || s.className.split(' ')[0],
      top: Math.round(s.getBoundingClientRect().top + window.scrollY),
      h: Math.round(s.getBoundingClientRect().height)
    }))
  )`));

  console.log(`page sections: ${sections.length}`);
  for (const s of sections) {
    if (s.h < 40) continue;
    // rola para o topo da seção e fotografa a viewport
    await evalJs(`(() => {
      const html = document.documentElement;
      const prev = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto';
      window.scrollTo(0, ${s.top});
      html.style.scrollBehavior = prev;
      return true;
    })()`);
    await sleep(450);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const safe = String(s.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const file = path.join(OUT_DIR, `${safe}-${W}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`  ${safe} h=${s.h} -> ${osize(file)}`);
  }
  ws.close();
} catch (e) {
  console.error('erro:', e.message);
} finally {
  brave.kill('SIGKILL');
}

function osize(f) {
  try { return (fs.statSync(f).size / 1024).toFixed(0) + 'KB'; } catch { return '?'; }
}
