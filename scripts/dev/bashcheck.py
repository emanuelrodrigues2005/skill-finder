"""Verificador leve de sintaxe bash (sem executar bash).

Não substitui `bash -n`, mas pega os erros reais de digitação:
- blocos if/fi, case/esac, do/done desbalanceados
- parênteses/colchetes/chaves desbalanceados fora de strings e comentários
- heredoc aberto sem fechamento
- aspas simples/duplas não fechadas
- funções declaradas sem corpo
"""
import re
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()

errors = []
i = 0
n = len(src)
out = []          # código com strings/comentários removidos
quote = None
line = 1
in_heredoc = None
heredoc_delim = None

while i < n:
    ch = src[i]
    if ch == '\n':
        line += 1
        if quote is None:
            out.append('\n')
            # heredoc: consome até o delimitador
            if in_heredoc:
                rest = src[i + 1:]
                m = re.search(r'(?m)^' + re.escape(heredoc_delim) + r'\s*$', rest)
                if not m:
                    errors.append(f'linha {line}: heredoc {heredoc_delim!r} sem fechamento')
                    i = n
                    break
                block_end = i + 1 + m.end()
                line += rest[:m.end()].count('\n')
                i = block_end
                in_heredoc = None
                heredoc_delim = None
                continue
            i += 1
            continue
        if quote is None:
            out.append('\n')
        i += 1
        continue

    if quote is None and ch == '#':
        while i < n and src[i] != '\n':
            i += 1
        continue

    if quote is None and ch in '\'"':
        quote = ch
        start_line = line
        i += 1
        continue

    if quote is not None:
        if ch == '\\' and quote == '"':
            i += 2
            continue
        if ch == quote:
            quote = None
        elif ch == '\n':
            line += 1
        i += 1
        continue

    if ch == '<' and src.startswith('<<', i):
        m = re.match(r'<<-?\s*[\'"]?([A-Za-z_][A-Za-z0-9_]*)[\'"]?', src[i:])
        if m:
            in_heredoc = True
            heredoc_delim = m.group(1)
            i += m.end()
            continue

    out.append(ch)
    i += 1

if quote is not None:
    errors.append(f'string {quote} nunca fechada (começou na linha {start_line})')

code = ''.join(out)

# padrões de `case` usam `)` sem `(` correspondente: remova-os antes de contar
code_for_parens = re.sub(
    r'(?m)^[ \t]*(?:[^\s()|]+)(?:\|[^\s()|]+)*\)',
    'CASE_PATTERN',
    code,
)
# também cobre `case ... in padrao)` na mesma linha
code_for_parens = re.sub(
    r'(?<=\bin )(?:[^\s()|]+)(?:\|[^\s()|]+)*\)',
    'CASE_PATTERN',
    code_for_parens,
)

if code_for_parens.count('(') != code_for_parens.count(')'):
    errors.append(
        f'parênteses desbalanceados: ( {code_for_parens.count("(")} vs ) {code_for_parens.count(")")}'
    )
if code_for_parens.count('{') != code_for_parens.count('}'):
    errors.append(
        f'chaves desbalanceadas: {{ {code_for_parens.count("{")} vs }} {code_for_parens.count("}")}'
    )

words = re.findall(r'(?m)(?<![\w-])(if|then|elif|else|fi|case|esac|for|while|until|do|done|function)(?![\w-])', code)
counts = {}
for w in words:
    counts[w] = counts.get(w, 0) + 1

openers = counts.get('if', 0) + counts.get('elif', 0)
if counts.get('fi', 0) != counts.get('if', 0):
    errors.append(f"if ({counts.get('if', 0)}) vs fi ({counts.get('fi', 0)})")
if counts.get('case', 0) != counts.get('esac', 0):
    errors.append(f"case ({counts.get('case', 0)}) vs esac ({counts.get('esac', 0)})")

# do/done: 'for x in y; do' ou 'while ...; do'; 'do' também aparece em 'todo' mas a
# regex usa limite de palavra. Laços por linha e blocos ${x:-do} já saíram nas strings.
loops = counts.get('for', 0) + counts.get('while', 0) + counts.get('until', 0)
if counts.get('done', 0) != loops:
    errors.append(f"laços ({loops}) vs done ({counts.get('done', 0)})")

# funcoes: 'nome() {' precisa de '{'
for m in re.finditer(r'(?m)^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*(\{)?', code):
    if not m.group(2):
        errors.append(f'função {m.group(1)}() sem "{{" na mesma linha')

# shebang
if not src.startswith('#!'):
    errors.append('sem shebang (#!/usr/bin/env bash)')

print(f'arquivo: {path}')
print(f'linhas: {src.count(chr(10)) + 1}')
print(f'if={counts.get("if",0)} fi={counts.get("fi",0)} case={counts.get("case",0)} '
      f'esac={counts.get("esac",0)} loops={loops} done={counts.get("done",0)}')
if errors:
    print('\nERROS:')
    for e in errors:
        print(' -', e)
    sys.exit(1)
print('\nsem erros estruturais detectados')
