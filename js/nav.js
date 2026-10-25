/**
 * Menu mobile (drawer) com foco preso, bloqueio de scroll e suporte a teclado.
 */

export function initNav() {
  const toggle = document.getElementById('navToggle');
  const drawer = document.getElementById('navDrawer');
  if (!toggle || !drawer) return;

  const FOCUSABLE = 'a[href], button:not([disabled])';
  let lastFocused = null;

  const isOpen = () => drawer.classList.contains('is-open');

  function open() {
    lastFocused = document.activeElement;
    drawer.hidden = false;
    // força reflow para garantir a transição de entrada
    void drawer.offsetWidth;
    drawer.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Fechar menu de navegação');
    document.body.style.overflow = 'hidden';

    const first = drawer.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function close({ restoreFocus = true } = {}) {
    drawer.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Abrir menu de navegação');
    document.body.style.overflow = '';

    // espera a transição antes de ocultar
    window.setTimeout(() => {
      if (!isOpen()) drawer.hidden = true;
    }, 260);

    if (restoreFocus && lastFocused instanceof HTMLElement) {
      lastFocused.focus();
    }
  }

  function toggleDrawer() {
    if (isOpen()) close();
    else open();
  }

  toggle.addEventListener('click', toggleDrawer);

  // Fechar ao navegar dentro do drawer
  drawer.querySelectorAll('a[href]').forEach((link) => {
    link.addEventListener('click', () => close({ restoreFocus: false }));
  });

  // ESC fecha
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    }
  });

  // Tab preso dentro do drawer enquanto aberto
  drawer.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !isOpen()) return;

    const items = Array.from(drawer.querySelectorAll(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null
    );
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Redimensionou para desktop: garante estado limpo
  window.addEventListener('resize', () => {
    if (window.innerWidth >= 1024 && isOpen()) close({ restoreFocus: false });
  });
}

/**
 * Rolagem suave para links internos, compensando o header fixo.
 * Usa scroll-behavior nativo quando disponível e respeita
 * prefers-reduced-motion.
 */
export function initSmoothScroll() {
  const header = document.getElementById('siteHeader');
  const offset = () => (header ? header.offsetHeight + 12 : 0);

  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href');
      if (!id || id === '#') return;

      const target = document.querySelector(id);
      if (!target) return;

      e.preventDefault();

      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const top = target.getBoundingClientRect().top + window.scrollY - offset();

      window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });

      // move o foco para o destino, para leitores de tela
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });

      // limpa a marca de seção no histórico
      if (window.history.replaceState) {
        window.history.replaceState(null, '', id);
      }
    });
  });
}

/** Rola até a seção de contato e foca o primeiro campo do formulário. */
export function initCtaScroll() {
  document.querySelectorAll('[data-open-form]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.setTimeout(() => {
        const field = document.getElementById('nome');
        if (field) field.focus({ preventScroll: true });
      }, 620);
    });
  });
}
