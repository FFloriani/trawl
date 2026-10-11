import { LAYERS, type LayerName } from "../connectors/index.ts";
import type { SourceName } from "../core/types.ts";
import { domainOf } from "../core/util.ts";
import type { ClaimRecord, Depth, SessionData, SourceRecord, SubQuestion } from "./session.ts";

export type Phase = "plan" | "collect" | "crosscheck" | "verify" | "report" | "done";

interface DepthRules {
  subquestions: [number, number];
  minClaims: number;
  minDomains: number;
  /** Every planned layer needs a finding or an explicit gap. */
  layersRequired: boolean;
  crosscheck: boolean;
  /** Max key claims that must be verified before the report. */
  verifyCap: number;
  /** Also verify unflagged statistics. */
  verifyStats: boolean;
}

export const RULES: Record<Depth, DepthRules> = {
  quick: { subquestions: [2, 3], minClaims: 2, minDomains: 1, layersRequired: false, crosscheck: false, verifyCap: 3, verifyStats: false },
  standard: { subquestions: [3, 5], minClaims: 3, minDomains: 2, layersRequired: true, crosscheck: true, verifyCap: 12, verifyStats: false },
  deep: { subquestions: [4, 7], minClaims: 4, minDomains: 3, layersRequired: true, crosscheck: true, verifyCap: 25, verifyStats: true },
};

const SOURCE_LAYER: Record<SourceName | "page", LayerName> = {
  web: "official",
  page: "official",
  reddit: "community",
  reddit_comments: "community",
  hn: "community",
  x: "community",
  github: "code",
  github_issues: "code",
  github_code: "code",
  github_discussions: "community",
  arxiv: "academic",
  openalex: "academic",
  stackexchange: "qa",
  wikipedia: "reference",
  forums: "community",
  youtube: "community",
  mcp_registry: "tools",
  skillsmp: "tools",
};

export function layerOf(source: SourceRecord | undefined): LayerName | undefined {
  return source ? SOURCE_LAYER[source.source] : undefined;
}

export interface SubStatus {
  sub: SubQuestion;
  claims: number;
  keyClaims: number;
  domains: number;
  layersCovered: LayerName[];
  layersMissing: LayerName[];
  gaps: number;
  ok: boolean;
  problems: string[];
}

export interface Status {
  phase: Phase;
  rules: DepthRules;
  subs: SubStatus[];
  sourcesTotal: number;
  sourcesRead: number;
  claimsTotal: number;
  toVerify: ClaimRecord[];
  verified: number;
}

export function claimsToVerify(data: SessionData, rules: DepthRules): ClaimRecord[] {
  const all = [...data.claims.values()];
  const candidates = all.filter((c) => c.key || (rules.verifyStats && c.kind === "stat"));
  // Key claims backed by a single source first: they are the most likely to be wrong.
  candidates.sort((a, b) => Number(b.key) - Number(a.key) || a.sources.length - b.sources.length);
  return candidates.slice(0, rules.verifyCap);
}

export function computeStatus(data: SessionData): Status {
  const rules = RULES[data.meta.depth];
  const subs: SubStatus[] = (data.meta.plan?.subquestions ?? []).map((sub) => {
    const claims = [...data.claims.values()].filter((c) => c.subquestion === sub.id);
    const srcs = claims.flatMap((c) => c.sources.map((id) => data.sources.get(id))).filter((s): s is SourceRecord => Boolean(s));
    const domains = new Set(srcs.map((s) => domainOf(s.url)).filter(Boolean)).size;
    const covered = [...new Set(srcs.map(layerOf).filter((l): l is LayerName => Boolean(l)))];
    const gaps = data.gaps.filter((g) => g.subquestion === sub.id);
    // A gap tied to the layer (or naming it or one of its sources) counts as "looked, found nothing".
    const missing = sub.layers.filter(
      (l) =>
        !covered.includes(l) &&
        !gaps.some((g) => {
          const t = g.text.toLowerCase();
          return g.layer === l || t.includes(l) || LAYERS[l].sources.some((s) => t.includes(s));
        }),
    );
    const problems: string[] = [];
    if (claims.length < rules.minClaims) problems.push(`${claims.length}/${rules.minClaims} achados`);
    if (domains < rules.minDomains) problems.push(`${domains}/${rules.minDomains} domínios diferentes`);
    if (rules.layersRequired && missing.length) problems.push(`camadas sem achado nem lacuna: ${missing.join(", ")}`);
    return {
      sub,
      claims: claims.length,
      keyClaims: claims.filter((c) => c.key).length,
      domains,
      layersCovered: covered,
      layersMissing: missing,
      gaps: gaps.length,
      ok: problems.length === 0,
      problems,
    };
  });

  const toVerify = claimsToVerify(data, rules).filter((c) => !data.verifications.has(c.id));
  const verified = data.verifications.size;
  const sources = [...data.sources.values()];

  let phase: Phase;
  if (!data.meta.plan?.subquestions.length) phase = "plan";
  else if (subs.some((s) => !s.ok)) phase = "collect";
  else if (rules.crosscheck && !data.meta.crosscheck) phase = "crosscheck";
  else if (toVerify.length) phase = "verify";
  else if (!data.meta.report) phase = "report";
  else phase = "done";

  return {
    phase,
    rules,
    subs,
    sourcesTotal: sources.length,
    sourcesRead: sources.filter((s) => s.readAt).length,
    claimsTotal: data.claims.size,
    toVerify,
    verified,
  };
}

export function collectionBrief(
  sessionId: string,
  sub: SubQuestion,
  depth: Depth,
  sinceDays?: number,
  problems: string[] = [],
  available?: ReadonlySet<string>,
): string {
  const rules = RULES[depth];
  const all: string[] = sub.sources?.length ? [...new Set(sub.sources)] : [...new Set(sub.layers.flatMap((l) => [...LAYERS[l].sources]))];
  // Never send an agent to a source that is switched off on this machine.
  const sources = available ? all.filter((s) => available.has(s)) : all;
  const off = all.filter((s) => !sources.includes(s));
  const hostSearch = off.includes("web");
  const emptyLayers = available ? sub.layers.filter((l) => !LAYERS[l].sources.some((s) => available.has(s))) : [];
  return [
    `### ${sub.id}: ${sub.question}`,
    `Camadas: ${sub.layers.map((l) => `${l} (${LAYERS[l].label})`).join("; ")}`,
    problems.length ? `Falta: ${problems.join("; ")}` : "",
    off.length ? `Desligadas nesta máquina: ${off.join(", ")}.` : "",
    "Passos:",
    sources.length
      ? `1. \`trawl_collect\` com session_id="${sessionId}", subquestion="${sub.id}", sources=${JSON.stringify(sources)}${sinceDays ? `, since_days=${sinceDays}` : ""} e queries com 2 a 4 variações curtas (2 a 6 palavras: sinônimos, nome exato, versão em inglês; cada uma com uma palavra que desambigue o assunto). Ele busca tudo, ordena num ranking único, lê as melhores fontes e devolve os trechos. Uma chamada por sub-pergunta costuma bastar; repita só com termos novos.`
      : "1. Nenhuma fonte do servidor cobre estas camadas aqui.",
    hostSearch
      ? `   Para a parte web, use a busca web nativa da sua IDE${sinceDays ? ` (priorize o que for dos últimos ${sinceDays} dias)` : ""} e registre as fontes úteis com \`trawl_add_sources\` (subquestion="${sub.id}") antes de citar.`
      : "",
    emptyLayers.length && !hostSearch ? `   Camadas sem fonte ligada (${emptyLayers.join(", ")}): registre como lacuna com layer.` : "",
    `2. Se um trecho promete mais do que mostra, \`trawl_read\` com source_id e session_id. Prefira a fonte original a quem só repercute.`,
    `3. \`trawl_add_findings\` com subquestion="${sub.id}": cada achado com texto curto, tipo (fact|stat|opinion|inference), os ids [S…] que o sustentam e key=true se a conclusão depende dele. Achado-chave leva quotes: a frase exata copiada do trecho (idioma original, 5+ palavras); o servidor confere no texto da fonte e recusa se não bater. Registre em gaps o que procurou e não achou.`,
    `Meta: pelo menos ${rules.minClaims} achados de ${rules.minDomains} domínio(s) diferente(s)${rules.layersRequired ? ", e cada camada com achado ou lacuna registrada" : ""}.`,
    "Opinião de Reddit, HN ou X é tipo opinion; número só é stat com a fonte original do número.",
  ]
    .filter(Boolean)
    .join("\n");
}

const PHASE_LABEL: Record<Phase, string> = {
  plan: "1/5 plano",
  collect: "2/5 coleta",
  crosscheck: "3/5 cruzamento",
  verify: "4/5 verificação",
  report: "5/5 relatório",
  done: "concluída",
};

/** `available` = sources switched on here; when given, collection briefs skip the others. */
export function nextActionText(data: SessionData, status: Status, available?: ReadonlySet<string>): string {
  const { meta } = data;
  const id = meta.id;
  const lines: string[] = [`## Sessão ${id}: fase ${PHASE_LABEL[status.phase]}`, `Pergunta: ${meta.question}`];
  lines.push(
    `Profundidade: ${meta.depth} · fontes registradas: ${status.sourcesTotal} (lidas: ${status.sourcesRead}) · achados: ${status.claimsTotal} · verificados: ${status.verified}`,
  );
  if (status.subs.length) {
    lines.push("", "| Sub-pergunta | Achados | Domínios | Camadas cobertas | Situação |", "|---|---|---|---|---|");
    for (const s of status.subs) {
      lines.push(`| ${s.sub.id} ${s.sub.question.slice(0, 60)} | ${s.claims} | ${s.domains} | ${s.layersCovered.join(", ") || "-"} | ${s.ok ? "ok" : s.problems.join("; ")} |`);
    }
  }
  lines.push("", "### Próximo passo");

  switch (status.phase) {
    case "plan": {
      const [min, max] = status.rules.subquestions;
      lines.push(
        `Divida a pergunta em ${min} a ${max} sub-perguntas que não se sobreponham e que, juntas, respondam tudo. Para cada uma escolha as camadas que a respondem:`,
        ...Object.entries(LAYERS).map(([k, v]) => `- ${k}: ${v.label} (${v.sources.join(", ")})`),
        "Fonte oficial só existe para algumas perguntas: regra, preço, lei, especificação, anúncio, notas de patch. Em jogo (build, meta), hobby, opinião ou experiência de uso, a melhor evidência é dado de uso de muita gente, guias de quem pratica bem e a comunidade: não planeje a pesquisa em torno de fonte oficial que não existe; se não houver, registre a lacuna uma vez e siga.",
        `Em pesquisa sobre produto, ferramenta ou tendência, inclua a camada community em pelo menos uma sub-pergunta. Em ${meta.depth === "deep" ? "deep, crie também uma sub-pergunta cética (o melhor argumento contra a conclusão esperada)" : "standard ou deep, não deixe de fora a visão contrária"}.`,
        "Se o assunto tem site, documentação ou blog oficial, passe os domínios em official_domains (o ranking os trata como fonte oficial). Se tem fórum Discourse próprio (ex.: discuss.python.org), passe em forums.",
        "Escolha as fontes pelo assunto: se alguma fonte das camadas não combina, passe sources na sub-pergunta só com as que combinam. Ex.: em jogo, culinária, esporte ou saúde, Hacker News e GitHub só trazem ruído; em tema técnico ou de software, mantenha.",
        `Depois chame \`trawl_plan\` com session_id="${id}".`,
      );
      break;
    }
    case "collect": {
      const pending = status.subs.filter((s) => !s.ok);
      lines.push(
        "Colete para as sub-perguntas pendentes. Se sua IDE tem subagentes (Claude Code, Codex), dispare um por bloco abaixo, em paralelo, passando o bloco inteiro. Se não tem, faça um bloco por vez.",
        "",
        ...pending.map((s) => collectionBrief(id, s.sub, meta.depth, meta.sinceDays, s.problems, available) + "\n"),
        `Ao terminar, chame \`trawl_next\` com session_id="${id}".`,
      );
      break;
    }
    case "crosscheck":
      lines.push(
        `Leia os achados com \`trawl_crosscheck\` (só session_id="${id}") e devolva no mesmo tool:`,
        "- conflicts: onde as fontes dizem coisas opostas (tema, os lados, qual tem evidência mais forte e por quê, ids dos achados);",
        "- consensus: o que todas as camadas confirmam, inclusive fontes que discordam no resto;",
        "- blind_spots: o que nenhuma fonte cobriu;",
        "- strongest_evidence e weakest_evidence.",
        "Ordem de força: dado oficial, estudo revisado ou dado de uso de muita gente com método claro > documentação e código > guia de quem pratica e imprensa séria > relato de usuário > opinião solta.",
      );
      break;
    case "verify":
      lines.push(
        `Verifique estes ${status.toVerify.length} achados na fonte ORIGINAL (não em quem repercute). Se a IDE tem subagentes, divida em grupos e rode em paralelo.`,
        "",
        ...status.toVerify.map((c) => `- ${c.id} [${c.kind}${c.key ? ", chave" : ""}] ${c.text} (fontes: ${c.sources.join(", ") || "nenhuma"})`),
        "",
        "Para cada um: ache a fonte primária, confira número, data, autor e contexto, e procure a melhor fonte que contradiga.",
        `Registre com \`trawl_verify\` (session_id="${id}"): verdict = confirmed | corrected | unverified | false, note curta, corrected_text quando corrigir, primary_url da fonte original (é registrada sozinha).`,
        "confirmed e corrected exigem quote: a frase exata da fonte primária que prova, no idioma original. O servidor lê a fonte e confere palavra por palavra; se não achar, recusa. Sem frase que prove, o veredito é unverified.",
      );
      break;
    case "report":
      lines.push(
        `Escreva o relatório e entregue com \`trawl_report\` (session_id="${id}"):`,
        "- title curto e específico;",
        "- summary: a resposta direta em um parágrafo, primeiro o que é certo, depois o que é disputado;",
        "- sections: 3 a 5 seções com títulos que já dizem a conclusão; texto corrido, cite com os ids entre colchetes, ex.: [S1a2b3c] ou [S1a2b3c, S4d5e6f];",
        "- conclusion: implicações e próximos passos, sem repetir o texto.",
        "Cite só ids registrados na sessão: o servidor recusa o relatório se houver id desconhecido. Achados com verdict false não entram; corrected entram já corrigidos.",
        "O servidor acrescenta sozinho: placar da verificação, guia do que afirmar ou evitar, o que a comunidade diz, lacunas, metodologia e lista de fontes.",
      );
      break;
    case "done":
      lines.push(`Pesquisa concluída. Relatório: ${meta.report?.md}`, meta.report?.html ? `HTML: ${meta.report.html}` : "");
      break;
  }
  return lines.filter((l) => l !== undefined).join("\n");
}
