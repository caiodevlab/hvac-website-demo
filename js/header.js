/**
 * Cabeçalho fixo: estado de rolagem, ano no rodapé e links de contato.
 */

import { CONFIG } from './config.js';

export function initHeader() {
  const header = document.getElementById('siteHeader');
  if (!header) return;

  const onScroll = () => {
    header.classList.toggle('is-scrolled', window.scrollY > 24);
  };

  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

/** Atualiza o ano corrente no rodapé. */
export function initYear() {
  const el = document.getElementById('anoAtual');
  if (el) el.textContent = String(new Date().getFullYear());
}

/**
 * Substitui os links de WhatsApp e e-mail pelos valores de CONFIG.
 * Elementos são marcados com data-wa-link / data-mail-link no HTML.
 */
export function initContactLinks() {
  const waUrl = `https://wa.me/${CONFIG.whatsappNumber}?text=${encodeURIComponent(
    CONFIG.whatsappMessage
  )}`;

  document.querySelectorAll('[data-wa-link]').forEach((el) => {
    el.setAttribute('href', waUrl);
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  });

  document.querySelectorAll('[data-wa-number]').forEach((el) => {
    el.textContent = CONFIG.whatsappDisplay;
  });

  document.querySelectorAll('[data-mail-link]').forEach((el) => {
    el.setAttribute('href', `mailto:${CONFIG.email}`);
  });
}
