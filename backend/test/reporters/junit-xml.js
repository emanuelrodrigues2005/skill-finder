'use strict';

/**
 * Reporter JUnit XML — próprio, sem dependência nova (issue #12, fase 2).
 *
 * Por que não `jest-junit`: a suíte não ganha dependência por ~60 linhas de
 * formatação, e o CI (F4) lê o XML do mesmo jeito. Plano B documentado: trocar
 * este arquivo por `jest-junit` é uma linha em `reporters` no `jest-cov.json`.
 *
 * Duas partes, de propósito:
 * - `renderJUnit(results)` é **pura**: recebe o agregado do Jest e devolve a
 *   string XML. É isso que `test/unit/junit-reporter.spec.ts` exercita, sem fs.
 * - a classe do reporter só grava o arquivo em `onRunComplete` — sem lógica de
 *   formatação no caminho que toca o disco.
 *
 * Saída: `backend/coverage/junit.xml` (`<rootDir>/coverage`), ignorada no Git.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Entidades obrigatórias em conteúdo e atributo. `'` e `"` entram porque vão em atributo. */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * XML 1.0 não aceita a maioria dos caracteres de controle. Um relatório com eles
 * é inválido e o CI rejeita o arquivo inteiro — melhor remover do que corromper.
 */
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Escapa texto para conteúdo ou valor de atributo XML. */
function escapeXml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/[&<>"']/g, (char) => ENTITIES[char]);
}

/** JUnit conta tempo em segundos com três casas; o Jest entrega milissegundos. */
function seconds(value) {
  const ms = Number(value);
  return (Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0).toFixed(3);
}

/** `<failure>` de um `it`, ou string vazia quando o caso passou/pulou. */
function failureOf(result) {
  const messages = Array.isArray(result.failureMessages)
    ? result.failureMessages.filter((message) => Boolean(message))
    : [];
  if (result.status !== 'failed') {
    return '';
  }
  if (messages.length === 0) {
    // Falhou sem mensagem (raro): o elemento precisa existir, senão um leitor de
    // JUnit contaria o caso como sucesso.
    return '<failure message="failed"/>';
  }
  const firstLine = String(messages[0]).split('\n')[0];
  return `<failure message="${escapeXml(firstLine)}">${escapeXml(messages.join('\n\n'))}</failure>`;
}

function renderCase(result, classname) {
  const name = escapeXml(result.fullName || result.title || '(anonymous)');
  const skipped = result.status === 'pending' || result.status === 'todo' ? '<skipped/>' : '';
  return (
    `<testcase classname="${classname}" name="${name}" time="${seconds(result.duration)}">` +
    `${skipped}${failureOf(result)}</testcase>`
  );
}

/**
 * Um `<testsuite>` por arquivo de teste. Devolve também as contagens próprias,
 * que alimentam o `<testsuites>` do topo — assim os dois níveis nunca divergem.
 */
function renderSuite(fileResult) {
  const classname = escapeXml(fileResult.testFilePath || '(unknown)');
  const results = Array.isArray(fileResult.testResults) ? fileResult.testResults : [];
  const cases = results.map((result) => renderCase(result, classname));

  // Falha que não pertence a nenhum `it` (erro de import, `beforeAll` estourado):
  // sem este caso sintético o relatório diria "0 testes" para um arquivo que na
  // verdade quebrou — o verde falso que o gate existe para impedir.
  const execError = fileResult.testExecError;
  if (execError) {
    const message = escapeXml(execError.message || 'test suite failed to run');
    cases.push(
      `<testcase classname="${classname}" name="(suite)" time="0.000">` +
        `<failure message="${message}">${message}</failure></testcase>`,
    );
  }

  const tests = results.length + (execError ? 1 : 0);
  const failures =
    results.filter((result) => result.status === 'failed').length + (execError ? 1 : 0);
  const skipped = results.filter(
    (result) => result.status === 'pending' || result.status === 'todo',
  ).length;
  const time = results.reduce((sum, result) => sum + (Number(result.duration) || 0), 0);

  return {
    tests,
    failures,
    skipped,
    time,
    xml:
      `<testsuite name="${classname}" tests="${tests}" failures="${failures}" ` +
      `skipped="${skipped}" time="${seconds(time)}">` +
      `\n${cases.join('\n')}\n</testsuite>`,
  };
}

/** XML JUnit completo a partir do agregado de resultados do Jest. Função pura. */
function renderJUnit(results) {
  const files = Array.isArray(results && results.testResults) ? results.testResults : [];
  const suites = files.map(renderSuite);
  const total = suites.reduce(
    (acc, suite) => ({
      tests: acc.tests + suite.tests,
      failures: acc.failures + suite.failures,
      skipped: acc.skipped + suite.skipped,
      time: acc.time + suite.time,
    }),
    { tests: 0, failures: 0, skipped: 0, time: 0 },
  );

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="jest" tests="${total.tests}" failures="${total.failures}" ` +
      `skipped="${total.skipped}" time="${seconds(total.time)}">`,
    ...suites.map((suite) => suite.xml),
    '</testsuites>',
  ];
  return `${lines.join('\n')}\n`;
}

class JUnitReporter {
  constructor(globalConfig, options = {}) {
    this.rootDir = (globalConfig && globalConfig.rootDir) || process.cwd();
    this.options = options;
  }

  /** Caminho absoluto do `.xml`. `outputFile`/`outputDirectory` permitem desviar no CI. */
  outputPath() {
    const file = this.options.outputFile || 'junit.xml';
    if (path.isAbsolute(file)) {
      return file;
    }
    const directory = this.options.outputDirectory || path.join(this.rootDir, 'coverage');
    return path.join(directory, file);
  }

  onRunComplete(_contexts, results) {
    const target = this.outputPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderJUnit(results || {}), 'utf8');
  }
}

module.exports = JUnitReporter;
module.exports.default = JUnitReporter;
module.exports.renderJUnit = renderJUnit;
module.exports.escapeXml = escapeXml;
