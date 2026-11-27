/**
 * Todo o texto de tela da SPA, em **pt-BR** (AGENTS.md, regra 6).
 *
 * Este é o único lugar do frontend com prosa de interface: as telas, os estados
 * reutilizáveis e o mapa `error.code` → mensagem leem daqui. Não há biblioteca de i18n, não há
 * `t()`, não há locale — a interface tem **um** idioma e ele é fixo por decisão de produto
 * (`docs/app/03-plano-app.md`, não-objetivo registrado).
 *
 * **O que não entra aqui:** texto que vem do catálogo. `name`, `summary`, `SKILL.md` e o
 * `label_en` das categorias são dado da fonte (scraping do skills.sh) e aparecem como
 * publicados, nunca traduzidos. Nomes de campo do contrato (`request_id`, `skill_id`,
 * `permalink`, `score`, `degraded_reason`) também ficam fora da tradução: são identificadores,
 * não rótulo de produto.
 *
 * Funções existem para o texto que precisa de número — contadores e medidas. A frase continua
 * morando aqui, não na tela.
 */
import type { DegradedReason } from "../types";

export const STR = {
  /** Constantes curtas que aparecem em mais de uma tela. */
  common: {
    /** Regra 3 do `AGENTS.md`: dado ausente é `null`, e a tela mostra `n/a` — nunca `0`. */
    na: "n/a",
    /** Campo do contrato exibido como identificador; diagnóstico para o suporte. */
    requestIdLabel: "request_id",
    /** Rótulo do `error.code` exibido junto da falha (diagnóstico, não mensagem). */
    codeLabel: "código:",
    /** Saída comum das telas sem resultado: o caminho de volta para o formulário. */
    newSearch: "Começar uma nova busca",
  },

  app: {
    title: "Busca de Skills",
    tagline: "Descreva, em linguagem natural, a skill de agente que você precisa.",
    skipToResults: "Ir para os resultados",
  },

  states: {
    loading: {
      default: "Carregando…",
      categories: "Carregando categorias…",
      skill: "Carregando skill…",
    },
    empty: {
      default: "nenhuma skill correspondeu — tente palavras mais amplas",
      /**
       * Só aparece quando o carregamento de categorias **falhou** (Fase 4 da auditoria): ali a
       * ausência é transitória e a frase é verdadeira. Com o catálogo sem categorias — o caso
       * de hoje, porque nenhuma fonte as publica — o seletor inteiro sai da tela e esta
       * mensagem junto: prometer uma categoria que a fonte nunca vai publicar é mentira.
       */
      noCategories: "nenhuma categoria disponível — você ainda pode buscar sem uma",
      noSearch: "nenhuma busca ainda — descreva a skill que você precisa na tela de busca",
    },
    error: {
      title: "Algo deu errado",
      retry: "Tentar de novo",
    },
  },

  copy: {
    button: "Copiar",
    /**
     * Duas redações por desfecho: a região viva só anuncia quando o texto muda, e a segunda
     * cópia precisa produzir uma string diferente da primeira.
     */
    copied: ["Copiado.", "Copiado novamente."],
    copyFailed: [
      "Não foi possível copiar — selecione o texto e pressione Ctrl+C.",
      "Ainda não foi possível copiar — selecione o texto e pressione Ctrl+C.",
    ],
  },

  search: {
    queryLabel: "O que você precisa que a skill faça?",
    /** Contador do texto aparado: `2/500 caracteres — mínimo de 3.` */
    queryCounter: (length: number, max: number, min: number): string =>
      `${String(length)}/${String(max)} caracteres — mínimo de ${String(min)}.`,
    categoryLabel: "Categoria (opcional)",
    anyCategory: "Todas as categorias",
    /** A falha de `GET /categories` é aviso ao lado do formulário, nunca bloqueio da busca. */
    categoriesUnavailableHint: "Você ainda pode buscar sem categoria.",
    submit: "Buscar",
    submitting: "Buscando…",
  },

  results: {
    heading: "Resultados",

    rateLimit: {
      codeLabel: "código:",
      detail: "— os resultados abaixo são a resposta anterior, ainda válida.",
    },

    empty: {
      /** Lista vazia com `degraded: true` nunca fica sem explicação (regra 7). */
      degradedHint: "a resposta está degradada — veja o aviso acima para o motivo",
    },

    /** Ações do estado vazio (US-07 AC2): cada link volta para `/` com uma dica de rascunho. */
    emptyActions: {
      heading: "O que você pode tentar",
      removeCategory: "Remover o filtro de categoria",
      removeCategoryNote: "— busque em todas as categorias em vez de uma",
      simplify: "Simplificar a descrição",
      simplifyNote: "— menos palavras costumam encontrar mais skills",
      examplePrefix: "Ou tente um exemplo:",
      /**
       * Exemplos de consulta. São texto de tela (o rótulo do link), por isso ficam aqui; o que
       * eles preenchem é a caixa de busca, e a consulta em si pode estar em qualquer idioma.
       */
      examples: ["extrair tabelas de um pdf", "resumir um changelog"] as const,
    },

    warnings: {
      heading: "Avisos",
      /**
       * Token de `warnings` → frase em pt-BR (regra 6). O contrato diz que o campo é
       * `string[]` livre, mas o servidor manda **tokens** (`search/constants.ts`): a tela
       * decide a frase por eles. Token fora do mapa cai em `unknown` — nunca fica em branco.
       */
      labels: {
        no_results: "nenhuma skill correspondeu à busca",
        explanation_from_template:
          "a explicação de pelo menos um item veio do template determinístico",
        source_stale: "o snapshot do catálogo está além da janela de ingestão",
        catalog_enriching:
          "o catálogo está sendo atualizado ao vivo com a fonte — repita a busca em instantes",
      } satisfies Readonly<Record<string, string>>,
      unknown: "aviso do servidor",
    },

    expired: {
      heading: "Esta busca expirou",
      detail:
        "Este permalink passou da janela de histórico (código HISTORY_EXPIRED), então a resposta " +
        "armazenada não pode mais ser reproduzida. Uma nova busca refaz o ranking a partir do " +
        "catálogo atual.",
    },
  },

  /**
   * A transcrição da resposta: a pergunta, a prosa de abertura, os tópicos e a nota de degradação.
   *
   * Fica separado de `results` porque é outro registro: `results` é a moldura da tela (título,
   * limite de uso, avisos, expirado) e `transcript` é a conversa em si. Nada aqui é dado do
   * catálogo — `name`, `explanation`, `caveats` e `recommendation.text` continuam como vieram.
   */
  transcript: {
    /** Nome acessível da lista: o mesmo do título da região, para o leitor de tela ligar os dois. */
    listLabel: "Resultados",

    status: {
      /** Linha de status única e persistente da tela de resultados (WCAG 4.1.3). */
      thinking: "Pensando…",
      found: (count: number): string =>
        count === 1 ? "1 skill encontrada" : `${String(count)} skills encontradas`,
    },

    /**
     * Linha de interpretação do `intent`. Os `keywords` são do servidor e vão como vieram; a
     * categoria só entra quando existe (`null` não vira `n/a` aqui: a linha fala do que a busca
     * entendeu, não de um campo do catálogo).
     */
    interpretation: (category: string | null, keywords: string): string =>
      category === null
        ? `palavras-chave: ${keywords}`
        : `categoria: ${category} — palavras-chave: ${keywords}`,

    lead: {
      none: "Nenhuma skill encontrada.",
      one: "Encontrei 1 skill:",
      many: (count: number): string => `Encontrei ${String(count)} skills:`,
      /**
       * R3: `recommendation` é nullable no contrato. Sem prosa do servidor a abertura não fica
       * num buraco — a frase diz onde está a explicação, em vez de repetir
       * `results[0].explanation`, que aparece no tópico logo abaixo.
       */
      noProse: "O ranking abaixo traz a explicação de cada skill.",
    },

    topic: {
      stars: "estrelas",
      installs: "instalações",
      vulnerabilities: "vulnerabilidades",
      noExplanation: "nenhuma explicação foi devolvida para este item",
      caveat: (text: string): string => `ressalva: ${text}`,
      /** `flags` é campo do contrato; os valores (`security_warn`, …) vêm do servidor. */
      flags: (values: string): string => `flags: ${values}`,
    },

    degraded: {
      /** Título por motivo do enum; motivo fora do enum cai no `fallback`. */
      headline: {
        source_stale: "O snapshot do catálogo está desatualizado",
        llm_unavailable:
          "O modelo de linguagem está indisponível — a intenção veio do fallback por palavras-chave",
      } satisfies Readonly<Record<DegradedReason, string>>,
      /**
       * R4: `low_confidence` chega rotulado como `llm_unavailable`, mas o modelo **respondeu** —
       * só com pouca confiança. A frase é escolhida por `degraded_reason` **e** por `llm.status`,
       * então aqui não se diz que o modelo está fora.
       */
      lowConfidence:
        "A intenção veio com pouca confiança — os termos encontrados podem estar imprecisos",
      fallback: "Resultados degradados",
      /** Nome do campo do contrato; o valor sai dentro de `<code>`. */
      reasonLabel: "degraded_reason:",
      ageSuffix: (hours: string, seconds: number): string =>
        ` — ${hours} h de idade (${String(seconds)} s)`,
    },
  },

  detail: {
    loading: "Carregando skill…",
    backToResults: "← voltar aos resultados",
    notFound: {
      title: "Skill não encontrada",
      detail: "Esta skill não existe no catálogo, ou seu id está malformado.",
    },
    noDescription: "Nenhuma descrição completa disponível para esta skill",
    /** Rodapé do estado vazio: o `SKILL.md` é dado da fonte e ausente é `n/a`. */
    skillMdHint: (na: string): string => `SKILL.md: ${na}`,
    present: "presente",
    fields: {
      category: "Categoria",
      stars: "Estrelas",
      installs: "Instalações",
      vulnerabilities: "Vulnerabilidades",
      security: "Segurança",
      source: "Fonte",
      repository: "Repositório",
      /** Nome de arquivo do formato da fonte: dado, não rótulo. */
      skillMd: "SKILL.md",
      snapshotDate: "Data do snapshot",
    },
    skillMdSection: "SKILL.md",
  },

  /**
   * `error.code` → mensagem exibida. A tela decide por **código**, nunca pelo texto do servidor
   * (`docs/app/02-arquitetura.md` §5.5): este mapa é o único caminho do código para a prosa.
   *
   * Cobre os 12 códigos do enum `openapi.yaml` › `components.schemas.ErrorBody.properties.code`,
   * o código de cliente `TIMEOUT` e o alias `UNKNOWN_CATEGORY` (o contrato congelado entrega
   * `VALIDATION_ERROR` com `details.reason`; `frontend/src/api.ts` remonta o alias).
   */
  errors: {
    /** Código fora do mapa nunca cai no texto do servidor: cai aqui. */
    unknown: "Algo deu errado. Tente de novo.",
    byCode: {
      BAD_REQUEST: "A requisição é inválida. Confira os dados e tente de novo.",
      VALIDATION_ERROR: "Alguns campos são inválidos. Confira a busca e tente de novo.",
      UNKNOWN_CATEGORY: "Essa categoria não existe. Escolha uma da lista.",
      UNAUTHORIZED: "Você não tem permissão para isso.",
      FORBIDDEN: "Você não tem permissão para isso.",
      NOT_FOUND: "Não encontramos o que você pediu.",
      CONFLICT: "Essa operação já está em andamento. Tente de novo em instantes.",
      HISTORY_EXPIRED: "Esta busca expirou. Comece uma nova busca.",
      RATE_LIMITED: "Muitas buscas.",
      LLM_BAD_RESPONSE: "Não foi possível usar a resposta do modelo de linguagem. Tente de novo.",
      /** Texto fixado pelo AC3 de US-08, traduzido para pt-BR junto com o resto da tela. */
      SOURCE_UNAVAILABLE: "Fonte de dados indisponível — tente de novo mais tarde.",
      NOT_READY: "O serviço ainda não está pronto. Tente de novo em instantes.",
      INTERNAL: "Algo deu errado do nosso lado. Tente de novo.",
      /** Código **do cliente** (`TIMEOUT_CODE` em `api.ts`): o servidor nunca o envia. */
      TIMEOUT: "A requisição demorou demais. Verifique sua conexão e tente de novo.",
    } as Readonly<Record<string, string>>,
    /** Só `RATE_LIMITED` com valor positivo ganha a frase do prazo de espera. */
    rateLimitedRetry: (seconds: number): string =>
      `Tente de novo em ${String(seconds)} segundo${seconds === 1 ? "" : "s"}.`,
  },
} as const;

/**
 * Token de `warnings` → rótulo visível em pt-BR (regra 6).
 *
 * O mapa lá dentro é `satisfies Readonly<Record<string, string>>`, o que preserva o tipo
 * literal de cada chave; indexar por `string` exige o cast local — o mesmo caminho de
 * `DEGRADED_HEADLINE` em `ResultsPage.tsx`. Token que o bundle ainda não conhece (contrato
 * à frente) não vira vazio nem some: cai em `unknown`, e a tela mostra o identificador em
 * `<code>` ao lado do rótulo.
 */
export function warningLabel(token: string): string {
  const labels: Readonly<Record<string, string | undefined>> = STR.results.warnings.labels;
  return labels[token] ?? STR.results.warnings.unknown;
}
