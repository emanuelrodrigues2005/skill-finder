"""Reparo byte-exato de mojibake cp1252->UTF-8.

Um arquivo lido como cp1252 e regravado como UTF-8 produz sequências como:
  'Ã©' (é), 'Ã§' (ç), 'Ã£' (ã)       -> letra acentuada
  'â€”' (—), 'â€“' (–), 'â€œ' (“)      -> travessão/aspas
  'â•' / 'â”' / 'â–' / 'â—'           -> box drawing, setas, bullets
  'Â ' (espaço)                       -> espaço   não separável

Detector: qualquer caractere 'â', 'Ã' ou 'Â' seguido de caractere não-ASCII.
Reparo:   code point < 0x100 -> byte de mesmo valor; senão tabela cp1252.
"""
import re
import sys
import pathlib

# 'â'/'Ã'/'Â' seguidos de um caractere que veio da faixa 0x80-0xBF do cp1252
MOJI_RE = re.compile('[\u00e2\u00c3\u00c2][\u0080-\u00bf\u2013\u2014\u2018\u2019\u201c\u201d'
                     '\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122\u0152\u0153'
                     '\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2009\u200a]')
ACCENTS = 'çãõáéíóúâêôà'


def encode_strict(s):
    out = bytearray()
    for ch in s:
        o = ord(ch)
        if o < 0x100:
            out.append(o)
        else:
            out += ch.encode('cp1252')      # levanta erro se não houver mapeamento
    return bytes(out)


def encode_lenient(s):
    out = bytearray()
    skipped = []
    for ch in s:
        o = ord(ch)
        if o < 0x100:
            out.append(o)
            continue
        try:
            out += ch.encode('cp1252')
        except UnicodeEncodeError:
            skipped.append(ch)
            out += ch.encode('utf-8')
    return bytes(out), skipped


def moji(text):
    return len(MOJI_RE.findall(text))


def repair_text(text):
    lines = text.split('\n')
    out, fixed, unresolved = [], 0, []
    for i, line in enumerate(lines, 1):
        if moji(line) == 0:
            out.append(line)
            continue
        try:
            new = encode_strict(line).decode('utf-8')
        except (UnicodeEncodeError, UnicodeDecodeError):
            try:
                raw, skipped = encode_lenient(line)
                new = raw.decode('utf-8', 'strict')
                if skipped:
                    unresolved.append((i, [hex(ord(c)) for c in skipped]))
            except (UnicodeEncodeError, UnicodeDecodeError):
                unresolved.append((i, ['falha']))
                out.append(line)
                continue
        if moji(new) <= moji(line):
            fixed += 1
            out.append(new)
        else:
            out.append(line)
    return '\n'.join(out), fixed, unresolved


def asc(s):
    return s.encode('ascii', 'backslashreplace').decode('ascii')


mode = sys.argv[1]
rc = 0
for p in [pathlib.Path(x) for x in sys.argv[2:]]:
    raw = p.read_bytes()
    bom = raw[:3] == b'\xef\xbb\xbf'
    if bom:
        raw = raw[3:]
    text = raw.decode('utf-8')

    before = moji(text)
    if before == 0 and not bom:
        print(f'{p.name:42} limpo (0 sequencias)')
        continue

    fixed_text, n, unresolved = repair_text(text)
    after = moji(fixed_text)
    print(f'{p.name:42} sequencias {before} -> {after}  linhas_corrigidas={n}  bom={bom}')

    if unresolved:
        print(f'   {len(unresolved)} linha(s) nao reparadas: {unresolved[:5]}')

    if after != 0:
        print('   ! ainda restam sequencias — NAO gravado')
        rc = 1
        continue

    if mode == 'fix':
        p.write_bytes(fixed_text.encode('utf-8'))
        print('   -> gravado UTF-8 sem BOM')
    else:
        print('   (check)')

sys.exit(rc)
