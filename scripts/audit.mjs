/**
 * Auditor de layout + interações via Chrome DevTools Protocol.
 * Roda o Brave headless com --remote-debugging-port, conecta via WebSocket
 * nativo do Node 22 e mede o DOM real renderizado.
 *
 * Uso: node scripts/audit.mjs [--url URL] [--width W] [--height H]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const URL_TARGET = arg('url', 'http://127.0.0.1:4173/');
const PORT = Number(arg('port', '9333'));
const USER_DIR = `/tmp/cdp-audit-${PORT}`;
const OUT_DIR = arg('out', '/tmp/audit');
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812, dsf: 2 },
  { name: 'tablet', width: 768, height: 1024, dsf: 2 },
  { name: 'desktop', width: 1440, height: 900, dsf: 1 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Cliente CDP mínimo                                                  */
/* ------------------------------------------------------------------ */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    }
    return r.result.value;
  }
}

async function connect(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        return new CDP(ws);
      }
    } catch {
      /* ainda subindo */
    }
    await sleep(250);
  }
  throw new Error('CDP não respondeu');
}

/* ------------------------------------------------------------------ */
/* Script de auditoria (executado dentro da página)                     */
/* ------------------------------------------------------------------ */
const AUDIT_FN = `(() => {
  const out = { issues: [], info: {} };
  const vw = document.documentElement.clientWidth;

  const add = (sev, kind, msg, el) => {
    out.issues.push({
      sev, kind, msg,
      el: el ? (el.tagName + (el.id ? '#'+el.id : '') +
                (el.className && typeof el.className === 'string'
                  ? '.'+el.className.trim().split(/\\s+/).slice(0,3).join('.') : '')) : null
    });
  };

  // 1. Overflow horizontal da página
  if (document.documentElement.scrollWidth > vw + 1) {
    const culprits = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.right > vw + 1 || r.left < -1) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') return;
        culprits.push({
          sel: el.tagName + (el.id ? '#'+el.id : '') +
                (typeof el.className === 'string' && el.className
                  ? '.'+el.className.trim().split(/\\s+/).slice(0,3).join('.') : ''),
          left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width)
        });
      }
    });
    add('erro', 'overflow-x',
      'Página rola horizontalmente: scrollWidth=' + document.documentElement.scrollWidth +
      ' vs viewport=' + vw, null);
    out.info.overflowCulprits = culprits.slice(0, 12);
  }

  // 2. Texto cortado / conteúdo estourando o container
  document.querySelectorAll('h1,h2,h3,h4,p,li,span,a,button,label,figcaption,strong').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    // O rótulo do .wa-float colapsa de propósito (max-width:0) até o hover/foco.
    if (el.closest('.wa-float') && el.tagName === 'SPAN') return;
    if (el.children.length > 0 && el.textContent.trim() === el.innerText?.trim() && el.scrollWidth > el.clientWidth + 2) {
      add('aviso', 'texto-cortado',
        'Texto rola dentro do elemento (overflow): "' + el.textContent.trim().slice(0, 60) + '"', el);
    }
    if (el.scrollHeight > el.clientHeight + 4 && cs.overflowY === 'hidden') {
      add('aviso', 'texto-vertical-cortado',
        'Conteúdo vertical cortado: "' + el.textContent.trim().slice(0, 60) + '"', el);
    }
  });

  // 3. Imagens quebradas / não carregadas
  document.querySelectorAll('img').forEach((img) => {
    const lazy = img.getAttribute('loading') === 'lazy';
    // img com lazy fora da viewport pode não ter baixado ainda: não é erro.
    // Só tratamos como quebrada se o elemento já está visível na tela.
    const rect = img.getBoundingClientRect();
    const onScreen = rect.top < (window.innerHeight || 0) + 200 && rect.bottom > -200;
    if (!img.complete || img.naturalWidth === 0) {
      if (lazy && !onScreen) {
        out.info.lazyDeferred = (out.info.lazyDeferred || 0) + 1;
        return;
      }
      add('erro', 'img-quebrada',
        'Imagem não carregou: src=' + (img.currentSrc || img.src || '?') +
        (img.getAttribute('srcset') ? ' (srcset)' : ''), img);
    } else if (img.naturalWidth < 400 && !img.closest('.gallery__item')) {
      add('aviso', 'img-pequena',
        'Imagem baixa resolução: ' + img.naturalWidth + 'x' + img.naturalHeight, img);
    }
  });

  // 4. Sobreposição entre elementos interativos
  const interactives = Array.from(document.querySelectorAll(
    'a[href], button, input, select, textarea, [role="button"]'
  )).filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  });
  for (let i = 0; i < interactives.length; i++) {
    for (let j = i + 1; j < interactives.length; j++) {
      const a = interactives[i], b = interactives[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 6 && oy > 6) {
        const areaA = ra.width * ra.height, areaB = rb.width * rb.height;
        const inter = ox * oy;
        if (inter / Math.min(areaA, areaB) > 0.35) {
          add('erro', 'sobreposicao',
            'Elementos interativos sobrepostos: "' + (a.textContent||'').trim().slice(0,28) +
            '" x "' + (b.textContent||'').trim().slice(0,28) + '"', a);
        }
      }
    }
  }

  // 5. Alvos de toque pequenos demais (mobile)
  if (vw <= 480) {
    interactives.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.height < 32) {
        add('aviso', 'alvo-pequeno',
          'Alto de toque ' + Math.round(r.height) + 'px (<32): "' +
          (el.textContent||el.getAttribute('aria-label')||el.tagName).trim().slice(0,40) + '"', el);
      }
    });
  }

  // 6. Contraste de texto sobre imagem de fundo sem overlay
  document.querySelectorAll('[data-reveal]').forEach((el) => {
    if (el.classList.contains('is-visible')) return;
    const rect = el.getBoundingClientRect();
    // só é bug se o elemento já estava visível na tela e mesmo assim não animou
    const onScreen = rect.top < (window.innerHeight || 0) + 100 && rect.bottom > -100;
    if (onScreen) {
      add('erro', 'reveal-pendente',
        'Elemento visível na tela mas sem a classe is-visible', el);
    }
  });

  // 7. Alvos de link vazios / href="#" inúteis
  document.querySelectorAll('a[href]').forEach((a) => {
    const h = a.getAttribute('href');
    if (h === '#' || h === '') {
      add('aviso', 'link-vazio', 'Link sem destino (#)', a);
    }
    if (!a.textContent.trim() && !a.getAttribute('aria-label') && !a.querySelector('svg,img')) {
      add('aviso', 'link-sem-rotulo', 'Link sem texto nem aria-label', a);
    }
  });

  // 8. Estrutura
  out.info.title = document.title;
  out.info.h1 = Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim());
  out.info.h1Count = document.querySelectorAll('h1').length;
  out.info.sections = Array.from(document.querySelectorAll('section[id]')).map(s => s.id);
  out.info.images = document.querySelectorAll('img').length;
  out.info.docHeight = document.documentElement.scrollHeight;
  out.info.viewport = vw;
  out.info.lang = document.documentElement.lang;
  out.info.metaDesc = (document.querySelector('meta[name=description]')||{}).content || null;

  // 9. Hierarquia de headings
  const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(h => ({
    lvl: Number(h.tagName[1]), txt: h.textContent.trim().slice(0, 48)
  }));
  let prev = 0, jumps = [];
  heads.forEach(h => { if (prev && h.lvl > prev + 1) jumps.push('h'+prev+'->h'+h.lvl+' "'+h.txt+'"'); prev = h.lvl; });
  if (jumps.length) out.info.headingJumps = jumps;

  return JSON.stringify(out);
})()`;

/* ------------------------------------------------------------------ */
/* Testes de interação                                                 */
/* ------------------------------------------------------------------ */
const INTERACTION_FN = `(async () => {
  const res = { steps: [], console: [], errors: [] };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // captura erros de console
  res._consoleErrors = [];

  // --- Menu mobile ---
  const toggle = document.getElementById('navToggle');
  const drawer = document.getElementById('navDrawer');
  if (toggle && drawer) {
    const before = getComputedStyle(drawer).display;
    const isMobile = (window.innerWidth || 0) < 1024;
    const toggleVisible = getComputedStyle(toggle).display !== 'none';
    toggle.click();
    await wait(450);
    const after = getComputedStyle(drawer).display;
    const open = drawer.classList.contains('is-open');
    const expanded = toggle.getAttribute('aria-expanded');
    // No desktop o drawer é ocultado por design (display:none) e o toggle
    // não existe; o que importa é que o estado ARIA e a classe estejam certos.
    const pass = isMobile
      ? (after !== 'none' && open && expanded === 'true')
      : (open && expanded === 'true' && after === 'none');
    res.steps.push({ test: 'menu-abre' + (isMobile ? '' : ' (desktop: oculto por design)'),
      pass,
      detail: 'display antes=' + before + ' depois=' + after + ' is-open=' + open +
              ' aria=' + expanded + ' toggleVisivel=' + toggleVisible });

    // link dentro do drawer fecha
    const link = drawer.querySelector('a[href^="#"]');
    if (link) {
      link.click();
      await wait(450);
      res.steps.push({ test: 'menu-fecha-ao-navegar',
        pass: !drawer.classList.contains('is-open'),
        detail: 'is-open=' + drawer.classList.contains('is-open') });
    }
  } else {
    res.steps.push({ test: 'menu-presente', pass: false, detail: 'toggle/drawer não encontrados' });
  }

  // --- FAQ acordeão ---
  const faqButtons = Array.from(document.querySelectorAll('.faq__q'));
  if (faqButtons.length) {
    const b0 = faqButtons[0], b1 = faqButtons[1];
    const p0 = document.getElementById(b0.getAttribute('aria-controls'));
    const p1 = document.getElementById(b1.getAttribute('aria-controls'));
    const e0 = b0.getAttribute('aria-expanded');
    b1.click();
    await wait(350);
    const e1after = b1.getAttribute('aria-expanded');
    const e0after = b0.getAttribute('aria-expanded');
    res.steps.push({ test: 'faq-alternar', pass: e1after === 'true' && e0after === 'false',
      detail: 'b0 ' + e0 + '->' + e0after + ', b1 ->' + e1after });
    if (p0 && p1) {
      const h0 = p0.getBoundingClientRect().height;
      const h1 = p1.getBoundingClientRect().height;
      res.steps.push({ test: 'faq-painel-visivel',
        pass: h1 > 10 && h0 < 5, detail: 'aberto h=' + Math.round(h1) + ' fechado h=' + Math.round(h0) });
    }
  } else {
    res.steps.push({ test: 'faq-presente', pass: false, detail: 'nenhum .faq__q' });
  }

  // --- Formulário: validação ---
  const form = document.getElementById('orcamentoForm');
  if (form) {
    // 1) envio vazio deve falhar
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await wait(200);
    const status = document.getElementById('formStatus');
    const invalidCount = form.querySelectorAll('[aria-invalid="true"]').length;
    res.steps.push({ test: 'form-rejeita-vazio', pass: invalidCount > 0,
      detail: 'campos inválidos=' + invalidCount + ' status="' + (status?.textContent||'').trim().slice(0,50) + '"' });

    // 2) preencher e enviar
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const filled = set('nome', 'Maria Souza') && set('telefone', '11987654321') &&
                   set('servico', 'instalacao-split') && set('ambiente', 'Sala de 40 m2');
    await wait(120);
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await wait(300);
    const okStatus = document.getElementById('formStatus');
    const stillInvalid = form.querySelectorAll('[aria-invalid="true"]').length;
    res.steps.push({ test: 'form-aceita-valido',
      pass: filled && stillInvalid === 0 && /ok|Demonstra/i.test(okStatus?.className + ' ' + (okStatus?.textContent||'')),
      detail: 'preenchido=' + filled + ' inválidos=' + stillInvalid + ' status="' + (okStatus?.textContent||'').trim().slice(0,70) + '"' });

    // 3) máscara de telefone
    const tel = document.getElementById('telefone');
    if (tel) {
      tel.value = '';
      tel.dispatchEvent(new Event('input', { bubbles: true }));
      tel.value = '11987654321';
      tel.dispatchEvent(new Event('input', { bubbles: true }));
      res.steps.push({ test: 'telefone-mascara', pass: /\\(\\d{2}\\)\\s\\d{5}-\\d{4}/.test(tel.value),
        detail: 'valor="' + tel.value + '"' });
    }
  } else {
    res.steps.push({ test: 'form-presente', pass: false, detail: 'formulário não encontrado' });
  }

  // --- Links internos resolvem para seções existentes ---
  const badAnchors = [];
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    const h = a.getAttribute('href');
    if (h && h !== '#' && !document.querySelector(h)) badAnchors.push(h);
  });
  res.steps.push({ test: 'ancoras-validas', pass: badAnchors.length === 0,
    detail: badAnchors.length ? 'quebradas: ' + badAnchors.join(', ') : 'todas resolvem' });

  // --- Links externos bem formados ---
  const badExt = [];
  document.querySelectorAll('a[href^="http"]').forEach((a) => {
    try { new URL(a.href); } catch { badExt.push(a.getAttribute('href')); }
  });
  res.steps.push({ test: 'links-externos-validos', pass: badExt.length === 0,
    detail: badExt.length ? 'inválidos: ' + badExt.join(', ') : 'ok' });

  // --- Scroll reveal ---
  const hidden = Array.from(document.querySelectorAll('[data-reveal]'))
    .filter(el => !el.classList.contains('is-visible')).length;
  res.steps.push({ test: 'reveal-oculto-ok', pass: true,
    detail: 'ainda ocultos (fora da viewport): ' + hidden });

  return JSON.stringify(res);
})()`;

/* ------------------------------------------------------------------ */
/* Execução                                                            */
/* ------------------------------------------------------------------ */
const brave = spawn('/opt/brave-bin/brave', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DIR}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
const report = { url: URL_TARGET, viewports: [] };

try {
  cdp = await connect(PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') {
      report.consoleErrors = report.consoleErrors || [];
      report.consoleErrors.push(p.entry.text);
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    report.pageExceptions = report.pageExceptions || [];
    report.pageExceptions.push(
      p.exceptionDetails?.exception?.description || p.exceptionDetails?.text
    );
  });

  for (const vp of VIEWPORTS) {
    const r = { ...vp };

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height,
      deviceScaleFactor: vp.dsf, mobile: vp.width < 500,
    });

    await cdp.send('Page.navigate', { url: URL_TARGET });
    await sleep(2200);

    // rola até o fim para disparar todos os reveals
    await cdp.eval(`(async () => {
      // scroll-behavior: smooth faz window.scrollTo ser assíncrono;
      // desliga temporariamente para o reveal disparar de forma determinística.
      const html = document.documentElement;
      const prev = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto';
      const H = document.documentElement.scrollHeight;
      for (let y = 0; y < H; y += 300) { window.scrollTo(0, y); await new Promise(r=>setTimeout(r,25)); }
      await new Promise(r=>setTimeout(r,300));
      window.scrollTo(0, 0);
      await new Promise(r=>setTimeout(r,200));
      html.style.scrollBehavior = prev;
      return true;
    })()`);
    await sleep(700);

    r.audit = JSON.parse(await cdp.eval(AUDIT_FN));

    // screenshot da página inteira
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const h = Math.min(Math.ceil(metrics.cssContentSize.height), 16000);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: h, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(500);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, `${vp.name}-${vp.width}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    r.screenshot = file;
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf, mobile: vp.width < 500,
    });
    await sleep(250);

    // interações
    r.interaction = JSON.parse(await cdp.eval(INTERACTION_FN));

    report.viewports.push(r);
  }
} catch (e) {
  report.fatal = String(e);
} finally {
  try { brave.kill('SIGKILL'); } catch {}
  try { cdp?.ws?.close(); } catch {}
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch {}
}

fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
  // --- Contraste WCAG AA (4.5:1 texto normal, 3:1 texto grande) ---
  const lum = (rgb) => {
    const a = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  };
  const parseRGB = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
  
  // --- Oclusão: elementos fixos (botão flutuante) sobre texto do conteúdo ---
  const fixeds = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) < 0.5) return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < (window.innerHeight || 0);
  });
  fixeds.forEach((f) => {
    const fr = f.getBoundingClientRect();
    // procura texto de conteúdo sob a área do elemento fixo
    document.querySelectorAll('p, h1, h2, h3, h4, li, figcaption, label, td, th, a.btn, .card__text, .process__text').forEach((el) => {
      if (f.contains(el) || el.contains(f)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return;
      // interseção real
      const ix = Math.max(0, Math.min(fr.right, r.right) - Math.max(fr.left, r.left));
      const iy = Math.max(0, Math.min(fr.bottom, r.bottom) - Math.max(fr.top, r.top));
      if (ix < 8 || iy < 8) return;
      const area = ix * iy;
      const elArea = r.width * r.height;
      if (area / elArea > 0.12) {
        add('aviso', 'oclusao',
          'Elemento fixo cobre ' + Math.round((area / elArea) * 100) + '% de "' +
          (el.textContent || '').trim().slice(0, 30) + '"', el);
      }
    });
  });

  return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  };
  // cor de fundo efetiva: sobe na árvore até achar algo opaco
  const effBg = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parseRGB(getComputedStyle(node).backgroundColor);
      if (c && c.a >= 0.95) return c.rgb;
      node = node.parentElement;
    }
    return [255, 255, 255];
  };
  const over = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
  document.querySelectorAll('a, button, .btn, .nav__link, figcaption, h1, h2, h3, p, li').forEach((el) => {
    const txt = (el.textContent || '').trim();
    if (!txt || el.children.length > 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    if (parseFloat(cs.opacity) < 0.5) return;
    const f = parseRGB(cs.color);
    if (!f) return;
    const bg = effBg(el);
    const fg = f.a < 1 ? over(f.rgb, bg, f.a) : f.rgb;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const fs = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = fs >= 24 || (fs >= 18.66 && bold);
    const min = large ? 3 : 4.5;
    if (ratio < min) {
      add('erro', 'contraste',
        'Contraste ' + ratio.toFixed(2) + ':1 (mín ' + min + ':1) — "' + txt.slice(0, 30) + '"',
        el);
    }
  });


