/** Diagnóstico pontual: mede overflow real de um elemento. */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9345;
const brave = spawn('/opt/brave-bin/brave', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-diag', '--hide-scrollbars',
  'about:blank',
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
      setTimeout(() => pending.has(i) && (pending.delete(i), rej(new Error('timeout'))), 20000);
    });
  };
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await sleep(2200);

  const out = await evalJs(`(() => {
    const el = document.querySelector('.btn--wa.btn--sm');
    if (!el) return JSON.stringify({error:'não encontrado'});
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const kids = Array.from(el.childNodes).map(n => ({
      type: n.nodeType === 3 ? 'text' : n.tagName,
      txt: (n.textContent||'').trim().slice(0,20),
      w: n.nodeType === 3 ? (n.textContent||'').trim().length*8 : Math.round(n.getBoundingClientRect().width)
    }));
    return JSON.stringify({
      scrollW: el.scrollWidth, clientW: el.clientWidth, rectW: Math.round(r.width),
      rectH: Math.round(r.height), padL: cs.paddingLeft, padR: cs.paddingRight,
      gap: cs.gap, fontSize: cs.fontSize, whiteSpace: cs.whiteSpace, flexWrap: cs.flexWrap,
      kids, text: el.textContent.trim(),
      parentW: Math.round(el.parentElement.getBoundingClientRect().width)
    }, null, 2);
  })()`);
  console.log(out);
  ws.close();
} catch (e) {
  console.error('erro:', e.message);
} finally {
  brave.kill('SIGKILL');
}
