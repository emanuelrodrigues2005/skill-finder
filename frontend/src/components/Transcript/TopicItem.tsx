/**
 * Um tópico da resposta: uma skill com a avaliação dela.
 *
 * `rank` é dado do contrato, não numeração decorativa — a lista é renderizada na ordem recebida
 * e o número que o servidor atribuiu vai junto do nome (regra 1: nada é reordenado no
 * navegador). A explicação, a ressalva e as `flags` são texto do servidor: aparecem como
 * publicados (regra 6).
 *
 * Os três números (estrelas, instalações, vulnerabilidades) ficam na linha do tópico, com `n/a`
 * onde o catálogo não trouxe o dado (regra 3 / US-04 AC3). `null` nunca vira `0`.
 *
 * O link é uma âncora comum, não um `<Link>` do react-router: a folha não depende do roteador
 * para renderizar (só a rota sabe onde ela está). O `?search=` do permalink vai junto, então um
 * recarregamento revalida a mesma busca em vez de perder o resultado.
 */
import type { ResultItem } from "../../types";
import { STR } from "../../ui/strings";
import { color, font, space } from "../../ui/tokens";
import { show } from "./format";

/** Destino do detalhe preservando a busca — o "voltar" daquela tela depende deste `?search=`. */
function skillHref(skillId: string, searchId: string): string {
  const suffix = searchId === "" ? "" : `?search=${encodeURIComponent(searchId)}`;
  return `/skills/${encodeURIComponent(skillId)}${suffix}`;
}

interface PairProps {
  label: string;
  value: number | null;
}

/** Um par termo/valor da linha de números. `null` cai em `n/a` pela `show`. */
function Pair({ label, value }: PairProps) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: space.xs }}>
      <dt
        style={{
          margin: 0,
          fontFamily: font.family.mono,
          fontSize: font.size.meta,
          color: color.textMuted,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          fontFamily: font.family.mono,
          fontVariantNumeric: "tabular-nums",
          fontSize: font.size.compact,
          color: color.textSubtle,
        }}
      >
        {show(value)}
      </dd>
    </div>
  );
}

interface TopicItemProps {
  item: ResultItem;
  /** `?search=` da rota, recebido por prop: a folha não lê a URL. */
  searchId: string;
}

export function TopicItem({ item, searchId }: TopicItemProps) {
  const { skill } = item;
  const explanation = item.explanation.trim();
  const caveat = item.caveats?.trim() ?? "";
  return (
    <li style={{ borderTop: `1px solid ${color.hairline}`, padding: `${space.md} 0` }}>
      <h3 style={{ margin: 0, fontSize: font.size.title, lineHeight: font.leading.snug }}>
        <a
          href={skillHref(skill.skill_id, searchId)}
          style={{ color: color.link, fontWeight: font.weight.strong, textDecoration: "none" }}
        >
          {item.rank}. {skill.name}
        </a>
      </h3>

      <p
        style={{
          margin: `${space.sm} 0 0`,
          color: color.textBody,
          fontSize: font.size.body,
          lineHeight: font.leading.body,
          maxWidth: "68ch",
        }}
      >
        {explanation === "" ? STR.transcript.topic.noExplanation : explanation}
      </p>

      {caveat === "" ? null : (
        <p
          style={{
            margin: `${space.xs} 0 0`,
            color: color.textMuted,
            fontSize: font.size.small,
            maxWidth: "68ch",
          }}
        >
          {STR.transcript.topic.caveat(caveat)}
        </p>
      )}

      {item.flags.length === 0 ? null : (
        <p style={{ margin: `${space.xs} 0 0`, color: color.flagText, fontSize: font.size.small }}>
          {STR.transcript.topic.flags(item.flags.join(", "))}
        </p>
      )}

      <dl
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: space.lg,
          margin: `${space.sm} 0 0`,
        }}
      >
        <Pair label={STR.transcript.topic.stars} value={skill.stars} />
        <Pair label={STR.transcript.topic.installs} value={skill.installs} />
        <Pair label={STR.transcript.topic.vulnerabilities} value={skill.vulnerability_count} />
      </dl>
    </li>
  );
}
