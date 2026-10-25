/**
 * Vértice Climatização — ponto de entrada.
 * Orquestra a inicialização dos módulos do site.
 */

import { initHeader, initYear, initContactLinks } from './header.js';
import { initNav, initSmoothScroll, initCtaScroll } from './nav.js';
import { initFaq } from './faq.js';
import { initForm } from './form.js';
import { initReveal } from './reveal.js';

function init() {
  // Marca que o JS está ativo: o CSS só oculta elementos [data-reveal]
  // quando esta classe existe, evitando conteúdo invisível se o JS falhar.
  document.documentElement.classList.add('js-ready');

  initHeader();
  initYear();
  initContactLinks();
  initNav();
  initSmoothScroll();
  initCtaScroll();
  initFaq();
  initForm();
  initReveal();

  // Sinaliza que o bundle carregou e inicializou sem erro.
  window.__verticeReady = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
