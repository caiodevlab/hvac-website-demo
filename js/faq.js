/**
 * FAQ em acordeão: um item aberto por vez, com a11y correta
 * (aria-expanded / aria-controls) e animação por grid-template-rows.
 */

export function initFaq() {
  const list = document.getElementById('faqList');
  if (!list) return;

  const items = Array.from(list.querySelectorAll('.faq__item'));
  const buttons = items
    .map((item) => item.querySelector('.faq__q'))
    .filter((b) => b instanceof HTMLButtonElement);

  function setOpen(button, open) {
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    if (!panel) return;

    button.setAttribute('aria-expanded', String(open));
    panel.dataset.open = String(open);
  }

  buttons.forEach((button) => {
    // estado inicial coerente com o HTML
    setOpen(button, button.getAttribute('aria-expanded') === 'true');

    button.addEventListener('click', () => {
      const isOpen = button.getAttribute('aria-expanded') === 'true';

      // fecha os demais
      buttons.forEach((other) => {
        if (other !== button) setOpen(other, false);
      });

      setOpen(button, !isOpen);
    });
  });

  // Navegação por setas entre os botões (padrão de disclosure group)
  buttons.forEach((button, index) => {
    button.addEventListener('keydown', (e) => {
      let target = null;

      if (e.key === 'ArrowDown') target = buttons[(index + 1) % buttons.length];
      else if (e.key === 'ArrowUp') target = buttons[(index - 1 + buttons.length) % buttons.length];
      else if (e.key === 'Home') target = buttons[0];
      else if (e.key === 'End') target = buttons[buttons.length - 1];

      if (target) {
        e.preventDefault();
        target.focus();
      }
    });
  });
}
