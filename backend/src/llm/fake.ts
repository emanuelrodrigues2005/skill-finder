/**
 * Provedor falso determinístico (`docs/app/03-plano-app.md` F2.5-t4).
 *
 * Roda em dev e CI **por injeção de dependência**, nunca por variável de ambiente
 * (regra 5). O caso é encontrado por `sha256(query)` sobre o mapa congelado em
 * `backend/test/fixtures/intents.json`: a mesma consulta devolve sempre a mesma
 * intenção, sem rede e sem relógio. Consulta desconhecida cai no fallback
 * lexical com `category: null` e `status: 'repaired'` — a mesma semântica da
 * reconstrução de keywords de §6.3, para o teste nunca receber lista vazia.
 *
 * Issue #40: o catálogo indexa o `search_doc` com `to_tsvector('english', ...)`,
 * então o falso também devolve `keywordsEn`. Sem um provedor de verdade em
 * dev/CI, a tradução sai de {@link ENGLISH_GLOSSARY} — um mapa PT -> EN congelado,
 * determinístico e sem rede, no lugar do que a LLM faria.
 *
 * `model` e `tokens` são `null`: nenhum provedor foi chamado.
 *
 * Issue #41: o mesmo arquivo traz o `FakeExplainParser`, determinístico e também
 * sem rede — a explicação sai dos campos do próprio candidato, com o nome sempre
 * por `{{skill:<id>}}` (a regra do §6.5), para a demo e o CI exercitarem o passo 7
 * sem um provedor de verdade.
 */
import type { Intent } from '@/contract/dto/search-response.dto';

import {
  skippedExplain,
  type ExplainCandidate,
  type ExplainParser,
  type ExplainRequest,
  type ExplainResult,
} from './explain-parser';
import { sha256Hex } from './intent-cache';
import { lexicalIntent, MAX_KEYWORDS } from './intent-schema';
import type { IntentParser, IntentParserResult } from './intent-parser';

/** Um caso congelado: consulta conhecida -> intenção esperada. */
export interface FakeIntentCase {
  readonly query: string;
  readonly intent: Intent;
}

/**
 * Glossário PT -> EN do provedor falso (issue #40).
 *
 * As chaves estão normalizadas — minúsculas e sem diacríticos — porque é assim
 * que {@link normalizeTerm} consulta: "segurança", "seguranca" e "SEGURANÇA"
 * caem na mesma entrada. Os valores são termos que aparecem em `name`/`summary`
 * do catálogo, que é indexado em inglês.
 *
 * Cobre o vocabulário das consultas do fixture e as famílias de pedido que a
 * especificação cita (`docs/app/01-spec-produto.md`): documentar, revisar,
 * testar, migrar, segurança, infraestrutura, frontend. Keyword fora do mapa não
 * é tradução — vira o fallback documentado de {@link englishKeywords}.
 */
const ENGLISH_GLOSSARY: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // Documentação e leitura
    documentar: 'document',
    documento: 'document',
    documentacao: 'documentation',
    documentacoes: 'documentation',
    api: 'api',
    apis: 'api',
    escrever: 'write',
    ler: 'read',
    resumir: 'summarize',
    analisar: 'analyze',
    // Revisão, teste e correção
    revisar: 'review',
    revisao: 'review',
    testar: 'test',
    teste: 'test',
    testes: 'test',
    testando: 'test',
    unitario: 'unit',
    unidade: 'unit',
    integracao: 'integration',
    corrigir: 'fix',
    corrige: 'fix',
    consertar: 'fix',
    erro: 'error',
    erros: 'error',
    refatorar: 'refactor',
    otimizar: 'optimize',
    melhorar: 'improve',
    // Dados e banco
    banco: 'database',
    dados: 'data',
    dado: 'data',
    postgres: 'postgres',
    postgresql: 'postgres',
    sql: 'sql',
    esquema: 'schema',
    migrar: 'migrate',
    migracao: 'migration',
    consulta: 'query',
    consultar: 'query',
    indice: 'index',
    tabela: 'table',
    armazenar: 'store',
    salvar: 'save',
    exportar: 'export',
    importar: 'import',
    // Segurança
    seguranca: 'security',
    seguro: 'security',
    vulnerabilidade: 'vulnerability',
    vulnerabilidades: 'vulnerability',
    vulneravel: 'vulnerable',
    ataque: 'attack',
    senha: 'password',
    segredo: 'secret',
    autenticacao: 'authentication',
    autenticar: 'authenticate',
    autorizacao: 'authorization',
    permissao: 'permission',
    criptografia: 'encryption',
    dependencia: 'dependency',
    dependencias: 'dependencies',
    licenca: 'license',
    auditoria: 'audit',
    // Infraestrutura e operação
    infraestrutura: 'infrastructure',
    implantar: 'deploy',
    implantacao: 'deployment',
    conteiner: 'container',
    nuvem: 'cloud',
    monitorar: 'monitor',
    observabilidade: 'observability',
    configurar: 'configure',
    configuracao: 'configuration',
    instalar: 'install',
    instalacao: 'installation',
    executar: 'run',
    rodar: 'run',
    planejar: 'plan',
    plano: 'plan',
    validar: 'validate',
    verificar: 'verify',
    gerar: 'generate',
    // Interface e frontend
    interface: 'interface',
    acessibilidade: 'accessibility',
    acessivel: 'accessible',
    pagina: 'page',
    tela: 'screen',
    formulario: 'form',
    componente: 'component',
    aplicacao: 'application',
    aplicacoes: 'application',
    // Busca e descoberta
    buscar: 'search',
    busca: 'search',
    encontrar: 'find',
    escolher: 'choose',
    ajuda: 'help',
    ajudar: 'help',
    util: 'useful',
    // Código em geral
    codigo: 'code',
    repositorio: 'repository',
    biblioteca: 'library',
    pacote: 'package',
    servico: 'service',
    servicos: 'services',
    servidor: 'server',
    cliente: 'client',
    usuario: 'user',
    projeto: 'project',
    arquivo: 'file',
    arquivos: 'files',
    criar: 'create',
    automatizar: 'automate',
    versao: 'version',
  }),
);

/** Minúsculas e sem diacríticos: a forma das chaves do glossário. */
function normalizeTerm(term: string): string {
  return term
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * Termos em inglês para o `tsquery` do `search_doc` (issue #40).
 *
 * Traduz o que o glossário conhece, na ordem em que as keywords chegaram, sem
 * repetir termo e respeitando {@link MAX_KEYWORDS}. Se **nenhuma** keyword é do
 * glossário — consulta já em inglês, ou fora do vocabulário — devolve as próprias
 * keywords: a busca nunca fica sem termo, e é a mesma regra de
 * `parseIntentPayload` para `keywords_en` vazio.
 *
 * Limitação declarada: a tradução é por palavra-chave inteira, não por frase —
 * `"banco de dados"` (uma keyword com espaços) não é traduzida. O fallback cobre
 * o caso com a lista original, e quem traduz de verdade é a LLM de produção.
 */
export function englishKeywords(
  keywords: readonly string[],
  limit: number = MAX_KEYWORDS,
): readonly string[] {
  const translated: string[] = [];
  for (const keyword of keywords) {
    const english = ENGLISH_GLOSSARY.get(normalizeTerm(keyword));
    if (english !== undefined && !translated.includes(english)) {
      translated.push(english);
    }
  }
  const chosen = translated.length > 0 ? translated : keywords;
  return chosen.slice(0, Math.max(0, limit));
}

export class FakeIntentParser implements IntentParser {
  private readonly casesByHash: Map<string, Intent>;

  constructor(cases: ReadonlyArray<FakeIntentCase>) {
    this.casesByHash = new Map(
      cases.map((testCase) => [sha256Hex(testCase.query), cloneIntent(testCase.intent)]),
    );
  }

  parse(query: string, _categories: readonly string[]): Promise<IntentParserResult> {
    const hit = this.casesByHash.get(sha256Hex(query));
    const intent = hit !== undefined ? cloneIntent(hit) : lexicalIntent(query);
    return Promise.resolve({
      intent,
      // O `search_doc` é inglês: os termos que casam com ele saem do glossário.
      keywordsEn: englishKeywords(intent.keywords),
      status: hit !== undefined ? 'ok' : 'repaired',
      model: null,
      tokens: null,
    });
  }
}

/** Cópia rasa com arrays/objetos novos: o chamador não muta a fixture. */
function cloneIntent(intent: Intent): Intent {
  return {
    category: intent.category,
    keywords: [...intent.keywords],
    filters: { exclude_with_vulnerabilities: intent.filters.exclude_with_vulnerabilities },
    language: intent.language,
    confidence: intent.confidence,
  };
}

/** Dado ausente é `n/a`, nunca zero (regra 3 do `AGENTS.md`). */
function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

/**
 * O porquê determinístico de um candidato (issue #41).
 *
 * Só campos do próprio candidato, e o nome sempre por `{{skill:<id>}}` — o texto
 * não escreve nome de skill, exatamente como o §6.5 exige da LLM de produção.
 */
function fakeWhy(candidate: ExplainCandidate): string {
  const category = candidate.category ?? 'n/a';
  return (
    `{{skill:${candidate.skill_id}}} atende ao pedido na categoria ${category}: ` +
    `${formatNumber(candidate.stars)} stars, ${formatNumber(candidate.installs)} installs e ` +
    `${formatNumber(candidate.vulnerability_count)} vulnerabilidade(s) reportada(s).`
  );
}

/** O aviso de evidência incompleta (≤ 160), ou `null` quando nada falta. */
function fakeCaveats(candidate: ExplainCandidate): string | null {
  const missing = [
    candidate.stars === null ? 'stars' : null,
    candidate.installs === null ? 'installs' : null,
    candidate.vulnerability_count === null ? 'vulnerabilities' : null,
  ].filter((field): field is string => field !== null);
  if (missing.length === 0) {
    return null;
  }
  const text =
    `Campos ausentes: ${missing.join(', ')}. A pontuação usa valor neutro e a interface ` +
    'mostra n/a em vez de zero.';
  return text.slice(0, 160);
}

/**
 * Provedor falso da explicação (issue #41).
 *
 * Sem relógio, sem aleatoriedade e sem rede: a mesma lista ranqueada devolve
 * sempre a mesma prosa. É o que permite a demo e o CI exercitarem o passo 7 sem
 * provedor de verdade — o teste injeta por `overrideProvider(EXPLAIN_PORT)`.
 */
export class FakeExplainParser implements ExplainParser {
  explain(request: ExplainRequest): Promise<ExplainResult> {
    const [rank1] = request.candidates;
    if (rank1 === undefined) {
      return Promise.resolve(skippedExplain('no_candidates'));
    }

    return Promise.resolve({
      items: request.candidates.map((candidate) => ({
        skill_id: candidate.skill_id,
        why: fakeWhy(candidate),
        caveats: fakeCaveats(candidate),
        repaired: false,
      })),
      recommendation: {
        skill_id: rank1.skill_id,
        why:
          `{{skill:${rank1.skill_id}}} é o começo recomendado: lidera o ranking determinístico ` +
          'desta busca.',
        repaired: false,
      },
      status: 'ok',
      reason: null,
      model: null,
      tokens: null,
    });
  }
}
