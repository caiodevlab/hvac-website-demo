/**
 * Formulário demonstrativo: validação no front-end, sem envio a servidor.
 * Mostra feedback acessível e nunca navega.
 */

const RULES = {
  nome: {
    required: true,
    min: 3,
    label: 'Nome',
    validate: (v) => {
      if (v.trim().length < 3) return 'Informe seu nome completo.';
      if (!/\s/.test(v.trim())) return 'Digite nome e sobrenome.';
      return '';
    },
  },
  telefone: {
    required: true,
    label: 'WhatsApp',
    validate: (v) => {
      const digits = v.replace(/\D/g, '');
      if (digits.length < 10) return 'Informe um telefone com DDD.';
      if (digits.length > 11) return 'Número muito longo. Confira o DDD.';
      return '';
    },
  },
  servico: {
    required: true,
    label: 'Tipo de serviço',
    validate: (v) => (v ? '' : 'Selecione o tipo de serviço.'),
  },
  ambiente: {
    required: true,
    min: 3,
    label: 'Ambiente',
    validate: (v) => {
      if (v.trim().length < 3) return 'Descreva brevemente o ambiente.';
      return '';
    },
  },
};

/** Máscara progressiva de telefone brasileiro. */
function maskPhone(value) {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function showToast(text) {
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  if (!toast || !toastText) return;

  toastText.textContent = text;
  toast.classList.add('is-visible');

  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 5200);
}

export function initForm() {
  const form = document.getElementById('orcamentoForm');
  if (!form) return;

  const status = document.getElementById('formStatus');
  const phoneInput = form.querySelector('#telefone');

  // máscara de telefone
  if (phoneInput) {
    phoneInput.addEventListener('input', () => {
      const pos = phoneInput.selectionStart;
      const before = phoneInput.value.length;
      phoneInput.value = maskPhone(phoneInput.value);
      const after = phoneInput.value.length;
      if (pos !== null) {
        phoneInput.setSelectionRange(pos + (after - before), pos + (after - before));
      }
    });
  }

  function validateField(name) {
    const rule = RULES[name];
    const input = form.elements[name];
    if (!rule || !input) return true;

    const errorEl = document.getElementById(`erro-${name}`);
    const message = rule.validate(input.value);

    if (message) {
      input.setAttribute('aria-invalid', 'true');
      if (errorEl) errorEl.textContent = message;
      return false;
    }

    input.removeAttribute('aria-invalid');
    if (errorEl) errorEl.textContent = '';
    return true;
  }

  // validação ao sair do campo e durante a digitação (após erro)
  Object.keys(RULES).forEach((name) => {
    const input = form.elements[name];
    if (!input) return;

    input.addEventListener('blur', () => validateField(name));
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') validateField(name);
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const results = Object.keys(RULES).map((name) => ({
      name,
      ok: validateField(name),
    }));
    const firstInvalid = results.find((r) => !r.ok);

    if (firstInvalid) {
      if (status) {
        status.className = 'form__status form__status--err is-visible';
        status.textContent = 'Revise os campos destacados antes de enviar.';
      }
      const el = form.elements[firstInvalid.name];
      if (el) el.focus();
      return;
    }

    // Demonstração: nenhuma requisição é feita.
    if (status) {
      status.className = 'form__status form__status--ok is-visible';
      status.textContent =
        'Demonstração concluída — os dados não foram enviados a nenhum servidor. ' +
        'Em produção, este ponto faria o POST para a API.';
    }

    showToast(
      'Solicitação registrada localmente. Esta é uma demonstração — nada foi enviado.'
    );

    form.reset();
    Object.keys(RULES).forEach((name) => {
      const input = form.elements[name];
      if (input) input.removeAttribute('aria-invalid');
      const err = document.getElementById(`erro-${name}`);
      if (err) err.textContent = '';
    });
  });
}
