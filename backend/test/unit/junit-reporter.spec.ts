import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Reporter JUnit próprio (`test/reporters/junit-xml.js`) — issue #12, fase 2.
 *
 * O alvo é `renderJUnit`, que é **pura**: entra o agregado de resultados que o
 * Jest passa em `onRunComplete`, sai XML. Nada de `fs` aqui — o `require` existe
 * porque o reporter precisa ser CJS puro (o Jest o carrega com `require`, antes
 * de qualquer transform do ts-jest, então ele não pode ser `.ts`).
 *
 * O que estes casos protegem:
 * - escape de `<`, `&`, `"` e `'` no nome e na mensagem (um relatório com `&` cru
 *   é XML inválido: o CI descarta o arquivo inteiro, não só a linha);
 * - caso que falha vira `<failure>` — nunca `<testcase>` "verde" com falha dentro;
 * - a contagem de `<testcase>` é igual ao total de testes, inclusive pulado e
 *   erro de suíte: um relatório que conta a menos mente sobre a suíte.
 */

type JestCaseStatus = 'passed' | 'failed' | 'pending' | 'todo';

interface JestCase {
  fullName?: string;
  title?: string;
  status: JestCaseStatus;
  duration?: number | null;
  failureMessages?: string[];
}

interface JestFile {
  testFilePath?: string;
  testExecError?: { message?: string } | null;
  testResults?: JestCase[];
}

interface AggregatedResults {
  testResults?: JestFile[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS puro: o Jest carrega o reporter com require, antes do transform
const { renderJUnit } = require('../reporters/junit-xml') as {
  renderJUnit: (results: AggregatedResults) => string;
};

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const UNIT_FILE = '/repo/backend/test/unit/ranking.spec.ts';

function caseOf(overrides: Partial<JestCase> = {}): JestCase {
  return {
    fullName: 'ranking orders by score',
    status: 'passed',
    duration: 12,
    failureMessages: [],
    ...overrides,
  };
}

function resultsOf(...files: JestFile[]): AggregatedResults {
  return { testResults: files };
}

/** Ocorrências literais — mais legível que regex para contar tags. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('junit reporter', () => {
  it('escapa <, &, aspas e apóstrofe no nome e na mensagem', () => {
    const xml = renderJUnit(
      resultsOf({
        testFilePath: UNIT_FILE,
        testResults: [
          caseOf({
            fullName: 'rejeita <script> & devolve "erro" do \'contrato\'',
            status: 'failed',
            failureMessages: ['Expected: <ok> Received: a & b "c" \'d\''],
          }),
        ],
      }),
    );

    expect(xml).toContain(
      'rejeita &lt;script&gt; &amp; devolve &quot;erro&quot; do &apos;contrato&apos;',
    );
    expect(xml).toContain('Expected: &lt;ok&gt; Received: a &amp; b &quot;c&quot; &apos;d&apos;');
    // Nenhum `<` cru que o parser leria como início de tag.
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('a & b');
  });

  it('transforma o caso que falha em <failure> com a primeira linha como message', () => {
    const xml = renderJUnit(
      resultsOf({
        testFilePath: UNIT_FILE,
        testResults: [
          caseOf({ status: 'failed', failureMessages: ['Expected: 200\nReceived: 500'] }),
        ],
      }),
    );

    expect(xml).toContain('<failure message="Expected: 200">');
    expect(xml).toContain('Expected: 200\nReceived: 500');
    expect(xml).toContain('failures="1"');
  });

  it('emite <failure> mesmo quando o Jest não dá mensagem', () => {
    const xml = renderJUnit(
      resultsOf({ testFilePath: UNIT_FILE, testResults: [caseOf({ status: 'failed' })] }),
    );

    expect(xml).toContain('<failure message="failed"/>');
    expect(xml).toContain('failures="1"');
  });

  it('conta um <testcase> por teste: passa, falha, pulado e erro de suíte', () => {
    const xml = renderJUnit(
      resultsOf(
        {
          testFilePath: UNIT_FILE,
          testResults: [
            caseOf({ fullName: 'a' }),
            caseOf({ fullName: 'b', status: 'failed', failureMessages: ['boom'] }),
            caseOf({ fullName: 'c', status: 'pending', duration: null }),
          ],
        },
        {
          testFilePath: '/repo/backend/test/unit/llm-cache.spec.ts',
          testExecError: { message: 'Cannot find module @/llm/cache' },
        },
      ),
    );

    // 3 casos do primeiro arquivo + 1 caso sintético do arquivo que não carregou.
    expect(count(xml, '<testcase')).toBe(4);
    expect(xml).toContain('tests="4"');
    expect(xml).toContain('failures="2"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('Cannot find module @/llm/cache');
  });

  it('marca o caso pulado com <skipped/> e começa pelo cabeçalho XML', () => {
    const xml = renderJUnit(
      resultsOf({
        testFilePath: UNIT_FILE,
        testResults: [caseOf({ fullName: 'todo ainda', status: 'todo' })],
      }),
    );

    expect(xml.startsWith(`${XML_DECLARATION}\n<testsuites name="jest"`)).toBe(true);
    expect(xml).toContain('<skipped/></testcase>');
    expect(xml).toContain('skipped="1"');
  });

  it('grava o relatório onde o reporter aponta, sem tocar no domínio', () => {
    // `require` do reporter real: o caminho de gravação é o mesmo que o
    // `jest-cov.json` usa. Aqui o alvo é temporário; o default (`coverage/junit.xml`)
    // é conferido pelo próprio `test:cov`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS puro (o Jest carrega o reporter com require)
    const JUnitReporter = require('../reporters/junit-xml') as new (
      globalConfig: { rootDir: string },
      options: { outputFile: string },
    ) => { outputPath: () => string; onRunComplete: (contexts: unknown, results: unknown) => void };

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'junit-'));
    const target = path.join(directory, 'junit.xml');
    const reporter = new JUnitReporter({ rootDir: directory }, { outputFile: target });

    reporter.onRunComplete(
      {},
      resultsOf({ testFilePath: UNIT_FILE, testResults: [caseOf({ fullName: 'gravado' })] }),
    );

    expect(reporter.outputPath()).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toContain('name="gravado"');
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
