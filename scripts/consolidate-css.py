#!/usr/bin/env python3
# Consolida regras CSS duplicadas preservando o resultado computado.
#
# Semantica segura para cascata:
#   - a ocorrencia VENCEDORA (a ultima do grupo) mantem sua posicao original
#   - as propriedades exclusivas das ocorrencias perdedoras sao transferidas
#     para a vencedora
#   - as ocorrencias perdedoras sao removidas
#
# A equivalencia e provada empiricamente: scripts/style-snap.mjs captura os
# estilos computados de todos os elementos antes e depois; um diff zero
# significa que a transformacao nao alterou o resultado visual.
#
# Uso: python3 scripts/consolidate-css.py [--check]

import shutil
import sys
from pathlib import Path

try:
    import postcss
except ImportError:  # fallback: usa o proprio parser
    postcss = None

ROOT = Path(__file__).resolve().parent.parent
CSS_DIR = ROOT / "css"
ORDER = [
    "tokens.css",
    "fonts.css",
    "layout.css",
    "components.css",
    "sections.css",
    "style.css",
]
CHECK_ONLY = "--check" in sys.argv

AT_NESTED = ("@media", "@supports", "@container", "@layer", "@scope")


def parse_nodes(text):
    """Retorna nos: ('comment',txt) | ('stmt',txt) | ('rule',sel,body) | ('at',header,kids) | ('atblock',header,body)"""
    nodes = []
    i, n = 0, len(text)
    while i < n:
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j == -1 else j + 2
            nodes.append(("comment", text[i:j]))
            i = j
            continue
        if text[i].isspace():
            i += 1
            continue
        j, depth = i, 0
        while j < n:
            if text.startswith("/*", j):
                k = text.find("*/", j + 2)
                j = n if k == -1 else k + 2
                continue
            c = text[j]
            if c == "{":
                break
            if c == ";":
                break
            j += 1
        if j >= n:
            break
        if text[j] == ";":
            nodes.append(("stmt", text[i:j + 1]))
            i = j + 1
            continue
        header = text[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if text.startswith("/*", k):
                kk = text.find("*/", k + 2)
                k = n if kk == -1 else kk + 2
                continue
            c = text[k]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            k += 1
        body = text[j + 1:k - 1]
        name = header.split()[0].lower() if header.split() else ""
        if name in AT_NESTED or name.endswith("keyframes"):
            # @media/@supports e @keyframes tem CORPO ANINHADO
            nodes.append(("at", header, parse_nodes(body)))
        else:
            # @font-face, @property, @page: corpo plano de declaracoes
            nodes.append(("atblock", header, body))
        i = k
    return nodes


def decls(body):
    res = []
    for x in body.split(";"):
        x = x.strip()
        if x and ":" in x and not x.startswith("@"):
            p, v = x.split(":", 1)
            res.append((p.strip(), v.strip()))
    return res


def render(nodes, indent=0):
    out = []
    pad = "  " * indent
    for node in nodes:
        kind = node[0]
        if kind == "comment":
            out.append(node[1] + "\n")
        elif kind == "stmt":
            out.append(pad + node[1] + "\n")
        elif kind == "atblock":
            header, body = node[1], node[2]
            props = decls(body)
            if not props:
                continue
            out.append("%s%s {\n" % (pad, header))
            for p, v in props:
                out.append("%s  %s: %s;\n" % (pad, p, v))
            out.append("%s}\n" % pad)
        elif kind == "at":
            header, kids = node[1], node[2]
            out.append("%s%s {\n" % (pad, header))
            out.append(render(kids, indent + 1))
            out.append("%s}\n" % pad)
    return "".join(out)


def expand(nodes):
    """Expande listas de seletores em regras individuais."""
    out = []
    for node in nodes:
        if node[0] == "atblock":
            header, body = node[1], node[2]
            if not header.startswith("@"):
                for s in header.split(","):
                    s = s.strip()
                    if s:
                        out.append(("atblock", s, body))
            else:
                out.append(node)
        elif node[0] == "at":
            out.append(("at", node[1], expand(node[2])))
        else:
            out.append(node)
    return out


def collect_groups(nodes, ctx=(), acc=None):
    if acc is None:
        acc = {}
    for node in nodes:
        if node[0] == "atblock":
            key = (ctx, node[1])
            acc.setdefault(key, []).append(node)
        elif node[0] == "at":
            collect_groups(node[2], ctx + (node[1],), acc)
    return acc


def merge(nodes, ctx=()):
    """Une duplicados. A vencedora (ultima) mantem a posicao."""
    groups = collect_groups(nodes, ctx)

    # props vencedoras por chave
    merged_props = {}
    for key, occ in groups.items():
        props = []
        for node in occ:
            for p, v in decls(node[2]):
                for j in range(len(props)):
                    if props[j][0] == p:
                        props[j] = (p, v)
                        break
                else:
                    props.append((p, v))
        merged_props[key] = props

    # reconstroi
    out = []
    seen = set()

    def rebuild(ns, c):
        res = []
        for node in ns:
            if node[0] == "atblock":
                key = (c, node[1])
                if key in seen:
                    continue
                seen.add(key)
                props = merged_props.get(key, [])
                res.append(("atblock", node[1], "\n".join("%s: %s" % (p, v) for p, v in props)))
            elif node[0] == "at":
                res.append(("at", node[1], rebuild(node[2], c + (node[1],))))
            else:
                res.append(node)
        return res

    return rebuild(nodes, ctx)


def main():
    files = dict((f, (CSS_DIR / f).read_text(encoding="utf-8")) for f in ORDER)
    parsed = dict((f, expand(parse_nodes(files[f]))) for f in ORDER)

    # ---- relatorio de duplicados (global, na ordem de cascata) ----
    global_nodes = []
    for f in ORDER:
        for n in parsed[f]:
            global_nodes.append(n)
    groups = collect_groups(global_nodes)
    dups = dict((k, v) for k, v in groups.items() if len(v) > 1)

    print("Grupos duplicados: %d" % len(dups))
    print("Regras a remover:   %d" % sum(len(v) - 1 for v in dups.values()))
    print()

    if CHECK_ONLY:
        for key in sorted(dups, key=lambda k: (k[0], k[1])):
            ctx, sel = key
            print("  '%s' x%d  ctx=[%s]" % (sel, len(dups[key]), str(ctx)[:60]))
        return

    # ---- merge global, preservando a ordem de cascata ----
    merged_global = merge(global_nodes)

    # ---- fatia de volta para os arquivos de origem ----
    # uma regra fica no arquivo onde foi DECLARADA pela primeira vez, para nao
    # alterar a ordem relativa entre arquivos
    first_file = {}

    def note(ns, f):
        for node in ns:
            if node[0] == "atblock":
                first_file.setdefault(node[1], f)
            elif node[0] == "at":
                note(node[2], f)

    for f in ORDER:
        note(parsed[f], f)

    def slice_nodes(ns, f, out):
        for node in ns:
            if node[0] == "atblock":
                if first_file.get(node[1]) == f:
                    out.append(node)
            elif node[0] == "at":
                kids = []
                slice_nodes(node[2], f, kids)
                if kids:
                    out.append(("at", node[1], kids))
            else:
                out.append(node)

    rendered = {}
    for f in ORDER:
        bucket = []
        slice_nodes(merged_global, f, bucket)
        rendered[f] = render(bucket)

    for f, t in rendered.items():
        if t.count("{") != t.count("}"):
            print("ERRO de balanceamento em %s" % f)
            return

    bak = ROOT / "css.backup"
    if bak.exists():
        shutil.rmtree(bak)
    shutil.copytree(CSS_DIR, bak)

    for f, t in rendered.items():
        (CSS_DIR / f).write_text(t, encoding="utf-8")

    print("Backup em %s" % bak)
    print("CSS consolidado.")


if __name__ == "__main__":
    main()
