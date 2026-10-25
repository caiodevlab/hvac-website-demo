/**
 * Pixel-diff: compara as capturas de tela de duas versoes do site.
 *
 * Uso: node scripts/pixdiff.mjs <urlA> <urlB> <outdir> [--width 1440]
 *
 * Serve para provar que uma mudanca de CSS nao alterou o resultado visual.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = 9800 + Math.floor(Math.random() * 150);
const brave = '/opt/brave-bin/brave';
const urlA = process.argv[2];
const urlB = process.argv[3];
const outDir = process.argv[4] || '/tmp/pixdiff';
const wIdx = process.argv.indexOf('--width');
const WIDTH = wIdx > 0 ? Number(process.argv[wIdx + 1]) : 1440;
const HEIGHT = 900;

mkdirSync(outDir, { recursive: true });

const child = spawn(brave, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cdp-pix-${PORT}`,
  'about:blank',
], { stdio: 'ignore' });

let ws = null, msgId = 0;
const pending = new Map();

for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const targets = await res.json();
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res2, rej) => {
        ws.addEventListener('open', res2, { once: true });
        ws.addEventListener('error', rej, { once: true });
      });
      break;
    }
  } catch { /* subindo */ }
}
if (!ws) { console.error('CDP nao conectou'); child.kill(); process.exit(1); }

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: WIDTH < 768 });

async function shoot(url, file) {
  await send('Page.navigate', { url });
  await sleep(2800);
  await evaluate(`(() => {
    const st = document.createElement('style');
    st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.appendChild(st);
    document.documentElement.classList.add('js-ready');
    document.querySelectorAll('[data-reveal]').forEach(e => {
      e.classList.add('is-visible'); e.style.opacity = '1'; e.style.transform = 'none';
    });
    window.scrollTo(0,0);
  })()`);
  await sleep(800);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

const a = await shoot(urlA, `${outDir}/A-${WIDTH}.png`);
const b = await shoot(urlB, `${outDir}/B-${WIDTH}.png`);
console.log(JSON.stringify({ a, b, width: WIDTH }));
ws.close();
child.kill();
process.exit(0);
