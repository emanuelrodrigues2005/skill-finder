/**
 * Fase 2 da auditoria — stopwords do fallback lexical (`lexicalKeywords`).
 *
 * Com a LLM fora, as keywords saem do próprio texto do usuário: são palavras
 * literais, sem tradução. Numa consulta em português, as palavras de *pedido*
 * (`preciso`, `agente`, `procurando`, `revise`) e as funcionais (`de`, `uma`,
 * `para`, ...) não existem no `search_doc`, que é indexado em inglês — cada uma
 * que sobra no `tsquery` só custa recall. As que descrevem a skill (`python`,
 * `frontend`) continuam.
 */
import { lexicalKeywords, MAX_KEYWORDS } from '@/llm/intent-schema';

describe('lexicalKeywords — stopwords PT (Fase 2)', () => {
  it('drops the words used to ask for the skill, keeping the ones that describe it', () => {
    const keywords = lexicalKeywords('preciso skill agente revise pull requests python procurando');

    expect(keywords).not.toContain('preciso');
    expect(keywords).not.toContain('agente');
    expect(keywords).not.toContain('procurando');
    // O que descreve a skill continua no `tsquery`.
    expect(keywords).toContain('python');
    expect(keywords).toContain('pull');
  });

  it('drops the functional words that carry no signal', () => {
    const keywords = lexicalKeywords('quero uma skill de frontend para o meu time');

    expect(keywords).not.toContain('uma');
    expect(keywords).not.toContain('para');
    expect(keywords).not.toContain('meu');
    expect(keywords).toContain('frontend');
  });

  it('never answers an empty list, even when the query is all stopwords', () => {
    // A busca não pode morrer por falta de termo: o fallback devolve a consulta.
    expect(lexicalKeywords('preciso de uma skill').length).toBeGreaterThan(0);
  });

  it('keeps the cap of eight terms', () => {
    const keywords = lexicalKeywords('alpha bravo charlie delta echo foxtrot golf hotel india');

    expect(keywords).toHaveLength(MAX_KEYWORDS);
  });
});
