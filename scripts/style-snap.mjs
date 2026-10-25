// Captura um snapshot dos estilos computados de todos os elementos da pagina.
// Usado para provar que a consolidacao de CSS nao alterou o resultado visual.
//
// Uso: node scripts/style-snap.mjs <url> <arquivo-saida>
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const PORT = 9700 + Math.floor(Math.random() * 200);
const brave = '/opt/brave-bin/brave';
const url = process.argv[2] || 'http://127.0.0.1:4173/';
const out = process.argv[3] || '/tmp/style-snap.json';
const WIDTHS = [375, 768, 1440];

const PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left',
  'width', 'height', 'minHeight', 'maxWidth', 'marginTop', 'marginRight',
  'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'gap', 'gridTemplateColumns', 'flexDirection', 'flexWrap',
  'alignItems', 'justifyContent', 'gridTemplateRows',
  'color', 'backgroundColor', 'backgroundImage', 'backgroundSize',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlign', 'textTransform', 'textDecorationLine', 'whiteSpace',
  'borderRadius', 'borderTopWidth', 'borderTopColor', 'borderTopStyle',
  'boxShadow', 'opacity', 'visibility', 'transform', 'transition',
  'zIndex', 'overflow', 'overflowX', 'overflowY', 'objectFit', 'aspectRatio',
  'filter', 'backdropFilter', 'clipPath', 'outlineOffset', 'flexBasis',
];

const child = spawn(brave, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cdp-snap-${PORT}`,
  'about:blank',
], { stdio: 'ignore' });

// --- conexão CDP (mesmo padrão do audit.mjs) ---
let ws = null;
let msgId = 0;
const pending = new Map();

for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const targets = await res.json();
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
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
  setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
  }, 30000);
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');

const SNAP = `(() => {
  const PROPS = ${JSON.stringify(PROPS)};
  const path = (el) => {
    const p = [];
    let n = el;
    while (n && n.nodeType === 1 && p.length < 7) {
      let s = n.tagName.toLowerCase();
      if (n.id) { s += '#' + n.id; break; }
      const cls = (n.className && typeof n.className === 'string')
        ? n.className.trim().split(/\\s+/).filter(Boolean).slice(0,3).join('.') : '';
      if (cls) s += '.' + cls;
      const par = n.parentElement;
      if (par) {
        const sibs = Array.from(par.children).filter(c => c.tagName === n.tagName);
        if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      p.unshift(s);
      n = n.parentElement;
    }
    return p.join(' > ');
  };
  const out = {};
  document.querySelectorAll('*').forEach((el, i) => {
    const cs = getComputedStyle(el);
    const o = {};
    for (const pr of PROPS) o[pr] = cs[pr];
    const r = el.getBoundingClientRect();
    o._rect = [Math.round(r.x*10)/10, Math.round(r.y*10)/10, Math.round(r.width*10)/10, Math.round(r.height*10)/10];
    o._tag = el.tagName.toLowerCase();
    o._text = (el.textContent || '').trim().slice(0, 40);
    out[path(el) + ' #' + i] = o;
  });
  return out;
})()`;

const results = {};
for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
  await send('Page.navigate', { url });
  await sleep(2800);
  // força a revelação para medir o layout final
  // estado deterministico: sem transicoes/animacoes, reveals no estado final
  await evaluate(`(() => {
    const st = document.createElement('style');
    st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.appendChild(st);
    document.documentElement.classList.add('js-ready');
    document.querySelectorAll('[data-reveal]').forEach(e => {
      e.classList.add('is-visible');
      e.style.opacity = '1';
      e.style.transform = 'none';
    });
    window.scrollTo(0,0);
  })()`);
  await sleep(700);
  results[width] = await evaluate(SNAP);
  console.error(`width ${width}: ${Object.keys(results[width]).length} elementos`);
}

writeFileSync(out, JSON.stringify(results));
console.log(out);
ws.close();
child.kill();
process.exit(0);
