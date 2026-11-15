import pathlib
import sys

files = [
    'docs/00-edital-projeto-2.md',
    'docs/01-analise-requisitos-e-arquitetura.md',
    'docs/02-aws-academy-limites-e-riscos.md',
    'docs/03-guia-pre-requisitos.md',
    'docs/04-plano-de-execucao.md',
    'docs/README.md',
    'docs/evidencias/sandbox.md',
]


def asc(s):
    return s.encode('ascii', 'backslashreplace').decode('ascii')


print(f"{'file':40} {'bytes':>7} {'lines':>6} {'BOM':>5} {'FFFD':>5} {'fences':>7}")
for p in files:
    raw = pathlib.Path(p).read_bytes()
    t = raw.decode('utf-8')
    fences = sum(1 for ln in t.splitlines() if ln.startswith('```'))
    print(f'{p.split("/")[-1]:40} {len(raw):>7} {t.count(chr(10)) + 1:>6} '
          f'{str(raw[:3] == b"[:3]")[:0]}{str(raw[:3] == bytes([239, 187, 191])):>5} '
          f'{t.count(chr(0xFFFD)):>5} {fences:>7}')

print()
checks = {
    'docs/02-aws-academy-limites-e-riscos.md': [
        'Restri\u00e7\u00f5es de IAM e identidade',
        'voclabs',
        'LabInstanceProfile',
        'Automa\u00e7\u00e3o',
        'uso_lockfile_placeholder',
    ],
    'docs/03-guia-pre-requisitos.md': [
        'Quadro de decis\u00f5es',
        'ATEN\u00c7\u00c3O: ARN',
        'chmod 400',
        'use_lockfile',
    ],
    'docs/04-plano-de-execucao.md': [
        'Plano de Execu\u00e7\u00e3o',
        'Mapa de rastreabilidade entrega',
    ],
}
rc = 0
for path, needles in checks.items():
    t = pathlib.Path(path).read_text(encoding='utf-8')
    print(path.split('/')[-1])
    for n in needles:
        ok = n in t
        if not ok and n != 'uso_lockfile_placeholder':
            rc = 1
        print(f'   {"OK   " if ok else "MISS "} {asc(n)}')

print()
print('RESULT:', 'todos os marcadores esperados presentes' if rc == 0 else 'faltou marcador')
sys.exit(rc)
