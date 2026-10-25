/** Mede a grade da galeria: posição real de cada item + buracos. */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9500 + Math.floor(Math.random() * 300);
const brave = spawn('/opt/brave-bin/brave', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cdp-gal-${PORT}`,
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
      setTimeout(() => pending.has(i) && (pending.delete(i), rej(new Error('timeout'))), 25000);
    });
  };
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'erro');
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await sleep(2500);

  const out = await evalJs(`(() => {
    const g = document.querySelector('.gallery');
    if (!g) return 'sem galeria';
    const cs = getComputedStyle(g);
    const gr = g.getBoundingClientRect();
    const cs_row = (el, k) => getComputedStyle(el).getPropertyValue(k === 'end' ? 'grid-row-end' : 'grid-row-start');
    const cs_col = (el, k) => getComputedStyle(el).getPropertyValue(k === 'end' ? 'grid-column-end' : 'grid-column-start');
    const items = Array.from(g.children).map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        i, cls: el.className.replace('gallery__item','').trim() || 'normal',
        // coordenadas RELATIVAS ao grid (o grid tem offset na página)
        x: Math.round(r.left - gr.left), y: Math.round(r.top - gr.top),
        w: Math.round(r.width), h: Math.round(r.height),
        cap: (el.querySelector('figcaption')?.textContent || '').trim().slice(0,34),
        rs: cs_row(el), re_: cs_row(el, 'end'), cs: cs_col(el), ce: cs_col(el, 'end'),
        offTop: el.offsetTop, offLeft: el.offsetLeft,
        transform: getComputedStyle(el).transform,
        visible: el.classList.contains('is-visible'),
        parentRows: cs.gridTemplateRows
      };
    });
    // detecta buracos: células da grade não cobertas
    const cols = cs.gridTemplateColumns.split(' ').map(v=>parseFloat(v));
    const rows = cs.gridTemplateRows.split(' ').map(v=>parseFloat(v));
    const rowY = []; let acc = 0;
    for (const r of rows) { rowY.push([acc, acc+r]); acc += r; }
    const holes = [];
    for (let ri=0; ri<rowY.length; ri++) {
      for (let ci=0; ci<cols.length; ci++) {
        const x0 = cols.slice(0,ci).reduce((a,b)=>a+b,0);
        const x1 = x0 + cols[ci];
        const cy = rowY[ri];
        const covered = items.some(it => it.x < x1-2 && it.x+it.w > x0+2 && it.y < cy[1]-2 && it.y+it.h > cy[0]+2);
        if (!covered) holes.push({row: ri+1, col: ci+1, x: Math.round(x0), y: Math.round(cy[0]), w: Math.round(cols[ci]), h: Math.round(cy[1]-cy[0])});
      }
    }
    return JSON.stringify({
      gridCols: cs.gridTemplateColumns, gridRows: cs.gridTemplateRows,
      autoFlow: cs.gridAutoFlow, dense: cs.gridAutoFlowDense, itemCount: items.length,
      items, holes
    }, null, 1);
  })()`);
  console.log(out);
  ws.close();
} catch (e) {
  console.error('erro:', e.message);
} finally {
  brave.kill('SIGKILL');
}
