/**
 * Animações de entrada (scroll reveal) com IntersectionObserver.
 * Respeita prefers-reduced-motion: se o usuário pediu menos movimento,
 * todos os elementos ficam visíveis imediatamente.
 */

export function initReveal() {
  const items = Array.from(document.querySelectorAll('[data-reveal]'));
  if (items.length === 0) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    {
      root: null,
      rootMargin: '0px 0px -8% 0px',
      threshold: 0.08,
    }
  );

  items.forEach((el) => observer.observe(el));

  // fallback: se algo estiver acima da dobra e o observer demorar, revela
  window.setTimeout(() => {
    items.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight) el.classList.add('is-visible');
    });
  }, 1200);
}
