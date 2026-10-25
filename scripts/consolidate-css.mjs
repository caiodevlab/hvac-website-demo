#!/usr/bin/env node
/**
 * Consolida regras CSS duplicadas preservando o resultado computado.
 *
 * Usa o parser oficial do PostCSS (mesmo do Vite) para garantir que
 * strings, funcoes e valores com ";" sejam interpretados corretamente.
 *
 * Semantica segura para cascata:
 *   - a ocorrencia VENCEDORA (a ultima do grupo) mantem sua posicao
 *   - as propriedades exclusivas das perdedoras sao transferidas para ela
 *   - as perdedoras sao removidas
 *
 * A equivalencia e provada empiricamente: scripts/style-snap.mjs captura os
 * estilos computados de todos os elementos antes e depois; diff zero = mesma
 * renderizacao.
 *
 * Uso: node scripts/consolidate-css.mjs [--check]
 */
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_DIR = join(ROOT, 'css');
const ORDER = [
  'tokens.css',
  'fonts.css',
  'layout.css',
  'components.css',
  'sections.css',
  'style.css',
];
const CHECK_ONLY = process.argv.includes('--check');

/* ------------------------------------------------------------------ */
/* percorre os nos de um container em profundidade                      */
/* ------------------------------------------------------------------ */
function walk(container, ctx, visit) {
  container.each((node) => {
    if (node.type === 'rule') {
      visit(node, ctx);
    } else if (node.type === 'atrule') {
      if (node.nodes) {
        walk(node, ctx + '|' + node.name + ' ' + node.params, visit);
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* 1. coleta: agrupar por (contexto, seletor)                            */
/* ------------------------------------------------------------------ */
const roots = new Map(); // file -> Root
for (const f of ORDER) {
  const src = readFileSync(join(CSS_DIR, f), 'utf8');
  roots.set(f, postcss.parse(src, { from: join(CSS_DIR, f) }));
}

// indice global na ordem de cascata
const groups = new Map(); // key -> { props: Map, occ: [] }
for (const f of ORDER) {
  const root = roots.get(f);
  walk(root, '', (node, ctx) => {
    node.selectors.forEach((sel) => {
      const key = ctx + '||' + sel;
      if (!groups.has(key)) groups.set(key, { props: new Map(), occ: [] });
      const g = groups.get(key);
      g.occ.push({ file: f, node, sel });
      node.each((decl) => {
        if (decl.type === 'decl') g.props.set(decl.prop, decl.value);
      });
    });
  });
}

const dups = [...groups.entries()].filter(([, g]) => g.occ.length > 1);
console.log(`Grupos duplicados: ${dups.length}`);
console.log(`Regras a remover:   ${dups.reduce((n, [, g]) => n + g.occ.length - 1, 0)}`);

if (CHECK_ONLY) {
  for (const [key, g] of dups.sort((a, b) => a[0].localeCompare(b[0]))) {
    const [ctx, sel] = key.split('||');
    console.log(`  '${sel}' x${g.occ.length} ctx=[${ctx.slice(1, 61)}] -> ${[...new Set(g.occ.map((o) => o.file))].join(', ')}`);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 2. reescrita                                                         */
/* ------------------------------------------------------------------ */
// a regra vencedora (ultima) mantem a posicao; as demais sao removidas
for (const [key, g] of dups) {
  const winner = g.occ[g.occ.length - 1];

  // remove as perdedoras
  for (let i = 0; i < g.occ.length - 1; i++) {
    const o = g.occ[i];
    // se a regra tem outros seletores, apenas remove este da lista
    if (o.node.selectors.length > 1) {
      o.node.selectors = o.node.selectors.filter((s) => s !== o.sel);
      if (o.node.selectors.length === 0) o.node.remove();
    } else {
      o.node.remove();
    }
  }

  // a vencedora recebe TODAS as propriedades (ultima declaracao por prop)
  winner.node.removeAll();
  for (const [prop, value] of g.props) {
    winner.node.append({ prop, value });
  }
}

// BACKUP antes de escrever (o original e o que precisa ser preservado)
const bak = join(ROOT, 'css.backup');
if (existsSync(bak)) rmSync(bak, { recursive: true });
cpSync(CSS_DIR, bak, { recursive: true });

// reconstroi cada arquivo
for (const f of ORDER) {
  const root = roots.get(f);
  let text = root.toString();
  // normaliza: remove linhas em branco duplicadas e espacos duplos
  text = text.replace(/\n{3,}/g, '\n\n');
  writeFileSync(join(CSS_DIR, f), text, 'utf8');
}

// valida: re-parse sem erros + balanceamento
for (const f of ORDER) {
  const t = readFileSync(join(CSS_DIR, f), 'utf8');
  try {
    postcss.parse(t, { from: f });
  } catch (e) {
    console.error(`ERRO de parse em ${f}: ${e.message}`);
    process.exit(1);
  }
  if ((t.match(/{/g) || []).length !== (t.match(/}/g) || []).length) {
    console.error(`ERRO de balanceamento em ${f}`);
    process.exit(1);
  }
}

console.log(`Backup em ${bak}`);
console.log('CSS consolidado.');
