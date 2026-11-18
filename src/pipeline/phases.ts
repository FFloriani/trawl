import { LAYERS, type LayerName } from "../connectors/index.ts";
import type { SourceName } from "../core/types.ts";
import { domainOf, oneLine } from "../core/util.ts";
import { checkOn, DEEP_MIN_CHARS, type ClaimRecord, type Depth, type SessionData, type SourceRecord, type SubQuestion } from "./session.ts";

export type Phase = "plan" | "collect" | "read" | "crosscheck" | "verify" | "report" | "done";

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
  /** How many of the best long sources must be read in full (0 = the phase is skipped). */
  deepRead: number;
}

export const RULES: Record<Depth, DepthRules> = {
  quick: { subquestions: [2, 3], minClaims: 2, minDomains: 1, layersRequired: false, crosscheck: false, verifyCap: 3, verifyStats: false, deepRead: 0 },
  standard: { subquestions: [3, 5], minClaims: 3, minDomains: 2, layersRequired: true, crosscheck: true, verifyCap: 12, verifyStats: false, deepRead: 6 },
  deep: { subquestions: [4, 7], minClaims: 4, minDomains: 3, layersRequired: true, crosscheck: true, verifyCap: 25, verifyStats: true, deepRead: 12 },
};

// ---------- deep reading ----------
// The server stores the full text of every source it reads, but `trawl_collect` shows only a few
// short passages. Long, procedural material (tutorials, videos, documentation) loses its steps,
// parameters and limits that way. The reading ledger says how much of each text reached the model;
// this phase asks for the full reading of the best long sources before the findings are crossed.

export interface ReadCandidate {
  id: string;
  title: string;
  source: SourceRecord["source"];
  author?: string;
  url: string;
  /** Sub-question the findings from this source are registered under. */
  subquestion: string;
  total: number;
  seen: number;
  deep: boolean;
  /** A gap names this source: someone looked and chose not to read it. */
  waived: boolean;
  /** Findings that already cite it. */
  cited: number;
  priority: number;
}

export interface ReadingStatus {
  /** Sources with stored text (one per URL). */
  stored: number;
  chars: number;
  deep: number;
  partial: number;
  unseen: number;
  /** The sources the research is expected to read in full, best first. */
  required: ReadCandidate[];
  /** Of those, the ones still to read (not read in depth and not waived by a gap). */
  pending: ReadCandidate[];
}

/** How much a kind of source repays a full reading: tutorials and pages hold steps and limits; threads are sampled by votes. */
const TYPE_WEIGHT: Partial<Record<SourceRecord["source"], number>> = {
  youtube: 1,
  page: 1,
  web: 1,
  arxiv: 0.9,
  forums: 0.8,
  github: 0.8,
  reddit: 0.7,
  hn: 0.7,
  github_discussions: 0.7,
  github_issues: 0.6,
  x: 0.2,
};

/**
 * What a full reading of this much text is worth. Past ~60k characters it falls: a huge
 * reference page (terms of use, a class reference) is searched by passage, not studied, and a
 * full reading of it is out of reach anyway.
 */
export function richness(total: number): number {
  const cap = 60_000;
  return total <= cap ? Math.log10(Math.max(total, 10)) : Math.log10(cap) * Math.sqrt(cap / total);
}

/** `kinds` limits the target set to some kinds of source (e.g. only "youtube"). */
export function readingStatus(data: SessionData, cap: number, kinds?: readonly string[]): ReadingStatus {
  const subs = data.meta.plan?.subquestions ?? [];
  const cited = new Map<string, number>();
  for (const c of data.claims.values()) for (const s of c.sources) cited.set(s, (cited.get(s) ?? 0) + 1);

  // One entry per URL: a redirect alias and the final id are the same text.
  const byUrl = new Map<string, ReadCandidate>();
  for (const [id, st] of data.reading) {
    const src = data.sources.get(id);
    if (!src || st.total <= 0) continue;
    const cand: ReadCandidate = {
      id,
      title: src.title,
      source: src.source,
      author: src.author,
      url: src.url,
      subquestion: src.subquestions.find((q) => subs.some((s) => s.id === q)) ?? subs[0]?.id ?? "Q1",
      total: st.total,
      seen: st.seen,
      deep: st.deep,
      waived: data.gaps.some((g) => g.text.includes(id)),
      cited: cited.get(id) ?? 0,
      priority: 0,
    };
    // relevance (the search score) × what a full reading is worth for this kind of source × richness
    cand.priority = Math.round((src.score ?? 50) * (TYPE_WEIGHT[src.source] ?? 0.8) * richness(st.total) * (cand.cited ? 1.15 : 1) * 10) / 10;
    const prev = byUrl.get(src.url);
    if (!prev) {
      byUrl.set(src.url, cand);
      continue;
    }
    const best = cand.seen >= prev.seen ? cand : prev;
    byUrl.set(src.url, { ...best, deep: cand.deep || prev.deep, waived: cand.waived || prev.waived, cited: Math.max(cand.cited, prev.cited) });
  }
  const all = [...byUrl.values()];
  // The target set is fixed by priority among every long source, read or not, so reading one
  // does not let a worse source slip into the list.
  const required = all
    .filter((c) => c.total >= DEEP_MIN_CHARS && (!kinds?.length || kinds.includes(c.source)))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.max(cap, 0));
  return {
    stored: all.length,
    chars: all.reduce((n, c) => n + c.total, 0),
    deep: all.filter((c) => c.deep).length,
    partial: all.filter((c) => !c.deep && c.seen > 0).length,
    unseen: all.filter((c) => !c.deep && c.seen === 0).length,
    required,
    pending: required.filter((c) => !c.deep && !c.waived),
  };
}

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
  /** The phases this session goes through, in order (the trust check and the deep reading are optional). */
  phases: Phase[];
  /** Whether the trust check (crosscheck, verification, checked quotes) is on for this session. */
  checking: boolean;
  rules: DepthRules;
  subs: SubStatus[];
  sourcesTotal: number;
  sourcesRead: number;
  claimsTotal: number;
  toVerify: ClaimRecord[];
  verified: number;
  reading: ReadingStatus;
}

export function claimsToVerify(data: SessionData, rules: DepthRules): ClaimRecord[] {
  const all = [...data.claims.values()];
  const candidates = all.filter((c) => c.key || (rules.verifyStats && c.kind === "stat"));
  // Key claims backed by a single source first: they are the most likely to be wrong.
  candidates.sort((a, b) => Number(b.key) - Number(a.key) || a.sources.length - b.sources.length);
  return candidates.slice(0, rules.verifyCap);
}

/**
 * `readCap` raises or lowers how many long sources count for the deep reading (default: the
 * session's, else the depth's); `readKinds` limits them to some kinds of source.
 */
export function computeStatus(data: SessionData, readCap?: number, readKinds?: readonly string[]): Status {
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

  const readTarget = readCap ?? data.meta.deepRead ?? rules.deepRead;
  const reading = readingStatus(data, readTarget, readKinds);

  // The trust check is off unless the user asked for it in this research; the phases follow it.
  const checking = checkOn(data.meta);
  const phases: Phase[] = ["plan", "collect"];
  if (readTarget > 0) phases.push("read");
  if (checking && rules.crosscheck) phases.push("crosscheck");
  if (checking) phases.push("verify");
  phases.push("report");

  let phase: Phase;
  if (!data.meta.plan?.subquestions.length) phase = "plan";
  else if (subs.some((s) => !s.ok)) phase = "collect";
  // Once the report exists the phase does not go back; the reading is offered at "done" instead.
  else if (reading.pending.length && !data.meta.report) phase = "read";
  else if (checking && rules.crosscheck && !data.meta.crosscheck) phase = "crosscheck";
  else if (checking && toVerify.length) phase = "verify";
  else if (!data.meta.report) phase = "report";
  else phase = "done";

  return {
    phase,
    phases,
    checking,
    rules,
    subs,
    sourcesTotal: sources.length,
    sourcesRead: sources.filter((s) => s.readAt).length,
    claimsTotal: data.claims.size,
    toVerify,
    verified,
    reading,
  };
}

export function collectionBrief(
  sessionId: string,
  sub: SubQuestion,
  depth: Depth,
  sinceDays?: number,
  problems: string[] = [],
  available?: ReadonlySet<string>,
  check = true,
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
    `2. Se um trecho promete mais do que mostra, \`trawl_read\` com source_id e session_id. Prefira a fonte original a quem só repercute. Vídeo, tutorial e documentação longos só mostram trechos aqui: não os leia inteiros agora, a fase de leitura funda cobra isso depois, nas melhores.`,
    check
      ? `3. \`trawl_add_findings\` com subquestion="${sub.id}": cada achado com texto curto, tipo (fact|stat|opinion|inference), os ids [S…] que o sustentam e key=true se a conclusão depende dele. Achado-chave leva quotes: a frase exata copiada do trecho (idioma original, 5+ palavras); o servidor confere no texto da fonte e recusa se não bater. Registre em gaps o que procurou e não achou.`
      : `3. \`trawl_add_findings\` com subquestion="${sub.id}": cada achado com texto curto, tipo (fact|stat|opinion|inference) e os ids [S…] que o sustentam. Não precisa de citação literal: a checagem de confiança está desligada nesta pesquisa. Registre em gaps o que procurou e não achou.`,
    `Meta: pelo menos ${rules.minClaims} achados de ${rules.minDomains} domínio(s) diferente(s)${rules.layersRequired ? ", e cada camada com achado ou lacuna registrada" : ""}.`,
    "Opinião de Reddit, HN ou X é tipo opinion; número só é stat com a fonte original do número.",
  ]
    .filter(Boolean)
    .join("\n");
}

const PHASE_NAME: Record<Phase, string> = {
  plan: "plano",
  collect: "coleta",
  read: "leitura funda",
  crosscheck: "cruzamento",
  verify: "verificação",
  report: "relatório",
  done: "concluída",
};

/** "3/5 leitura funda": the position counts only the phases this session actually goes through. */
function phaseLabel(status: Status): string {
  const i = status.phases.indexOf(status.phase);
  return i < 0 ? PHASE_NAME[status.phase] : `${i + 1}/${status.phases.length} ${PHASE_NAME[status.phase]}`;
}

const thousands = (n: number) => n.toLocaleString("pt-BR");

/** The reading instructions for one source: where to read it and where its findings go. */
function readBrief(sessionId: string, c: ReadCandidate): string {
  const kind = [c.source === "page" ? "página" : c.source, c.author].filter(Boolean).join(" · ");
  return [
    `### [${c.id}] ${oneLine(c.title, 110)}`,
    `${kind} · ${thousands(c.total)} caracteres · visto ${thousands(c.seen)} (${Math.round((c.seen / c.total) * 100)}%) · sub-pergunta ${c.subquestion}${c.cited ? ` · ${c.cited} achado(s) já citam` : ""}`,
    `1. \`trawl_read\` com source_id="${c.id}", session_id="${sessionId}" e max_chars=40000; continue com o offset que ele indicar até "Fim do conteúdo". Leia tudo, sem pular.`,
    `2. \`trawl_add_findings\` com subquestion="${c.subquestion}" e os achados abaixo.`,
  ].join("\n");
}

/** Up to 8 sources get a block each (ready to hand to a sub-agent); a longer list is one line per source. */
function readList(sessionId: string, list: ReadCandidate[], max = 40): string[] {
  if (list.length <= 8) return list.map((c) => readBrief(sessionId, c) + "\n");
  return [
    `Para cada fonte da lista: 1. \`trawl_read\` com source_id, session_id="${sessionId}" e max_chars=40000, seguindo o offset até "Fim do conteúdo"; 2. \`trawl_add_findings\` com a sub-pergunta da linha.`,
    "",
    ...list
      .slice(0, max)
      .map(
        (c) =>
          `- [${c.id}] ${c.source === "page" ? "página" : c.source}${c.author ? ` · ${c.author}` : ""} · ${oneLine(c.title, 80)} · ${thousands(c.total)} car. · visto ${Math.round((c.seen / c.total) * 100)}% · ${c.subquestion}${c.cited ? ` · ${c.cited} achado(s)` : ""}`,
      ),
    ...(list.length > max ? [`… e mais ${list.length - max} (read_sources do trawl_next filtra por tipo de fonte).`] : []),
    "",
  ];
}

function readRules(check: boolean): string[] {
  return [
    "Regras de quem lê (valem para todas as fontes acima):",
    "- Extraia o que serve à pergunta: passos na ordem, parâmetros e números (com a unidade), limites, versões, nomes exatos de menus, ferramentas e propriedades, erros e a correção, e o que o autor diz que NÃO funciona.",
    "- Um achado por ideia; um procedimento vira um achado com os passos numerados. Em vídeo, ponha o minuto [mm:ss] no texto do achado.",
    "- kind: vídeo, fórum e relato de uso são opinion (experiência de quem fez); documentação, especificação e código são fact; número só é stat com a fonte que o traz.",
    check
      ? "- quotes: a frase exata copiada do texto (idioma original, 5+ palavras) em todo stat e todo achado-chave; o servidor confere palavra por palavra."
      : "- Sem quotes: a checagem de confiança está desligada nesta pesquisa; escreva cada achado com o que a fonte diz, sem copiar frases.",
    "- Legenda automática erra nomes e números: na dúvida escreva (?) e confira na descrição. Não complete com o que você já sabe.",
    check
      ? "- Se o que leu contradiz um achado já registrado, registre o novo e cite o id do contrariado no texto (o cruzamento usa isso)."
      : "- Se o que leu contradiz um achado já registrado, registre o novo e cite o id do contrariado no texto.",
    "- Devolva ao coordenador só 3 linhas: a fonte, quantos achados registrou e o mais novo; o resto fica no servidor.",
  ];
}

/** `available` = sources switched on here; when given, collection briefs skip the others. */
export function nextActionText(data: SessionData, status: Status, available?: ReadonlySet<string>): string {
  const { meta } = data;
  const id = meta.id;
  const lines: string[] = [`## Sessão ${id}: fase ${phaseLabel(status)}`, `Pergunta: ${meta.question}`];
  lines.push(
    [
      `Profundidade: ${meta.depth}`,
      `checagem de confiança: ${status.checking ? "ligada" : "desligada"}`,
      `fontes registradas: ${status.sourcesTotal} (lidas: ${status.sourcesRead})`,
      `achados: ${status.claimsTotal}`,
      ...(status.checking ? [`verificados: ${status.verified}`] : []),
    ].join(" · "),
  );
  const rd = status.reading;
  if (rd.stored) {
    lines.push(
      `Leitura: ${rd.deep} a fundo · ${rd.partial} só em trechos · ${rd.unseen} sem leitura registrada (de ${rd.stored} fontes com texto guardado, ${thousands(rd.chars)} caracteres)`,
    );
  }
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
        ...pending.map((s) => collectionBrief(id, s.sub, meta.depth, meta.sinceDays, s.problems, available, status.checking) + "\n"),
        `Ao terminar, chame \`trawl_next\` com session_id="${id}".`,
      );
      break;
    }
    case "read": {
      const pend = status.reading.pending;
      lines.push(
        `Leia a fundo ${pend.length === 1 ? "esta fonte" : `estas ${pend.length} fontes`}: o servidor guardou o texto inteiro, mas ao modelo só chegaram trechos curtos. Tutorial, vídeo e documentação perdem o passo a passo, os parâmetros e os limites quando só o trecho que bate com a busca é lido.`,
        "Se sua IDE tem subagentes (Claude Code, Codex), dispare um por fonte, em paralelo, passando o bloco (ou a linha) da fonte e as regras abaixo (fontes curtas, de até ~15 mil caracteres, podem ir juntas em um agente só). Se não tem, leia uma por vez.",
        "",
        ...readList(id, pend),
        ...readRules(status.checking),
        "",
        `Ao terminar, chame \`trawl_next\` com session_id="${id}". Fonte que decidir não ler: registre uma lacuna com o id e o motivo (ex.: "[S…] não lida: repete a documentação").`,
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
        status.checking
          ? "Cite só ids registrados na sessão: o servidor recusa o relatório se houver id desconhecido. Achados com verdict false não entram; corrected entram já corrigidos."
          : "Cite só ids registrados na sessão: o servidor recusa o relatório se houver id desconhecido.",
        status.checking
          ? "O servidor acrescenta sozinho: placar da verificação, guia do que afirmar ou evitar, o que a comunidade diz, lacunas, metodologia e lista de fontes."
          : "O servidor acrescenta sozinho: o que a comunidade diz, lacunas, metodologia e lista de fontes. Esta pesquisa não passou por checagem de confiança: apresente os achados como o que as fontes dizem, sem chamá-los de verificados.",
      );
      break;
    case "done": {
      lines.push(`Pesquisa concluída. Relatório: ${meta.report?.md}`, meta.report?.html ? `HTML: ${meta.report.html}` : "");
      const pend = status.reading.pending;
      if (pend.length) {
        lines.push(
          "",
          `Leitura funda disponível: ${pend.length} fonte(s) longa(s) com texto guardado e só vistas em trechos. Para estudar o material, leia-as, registre os achados e, se mudarem a conclusão, gere o relatório de novo (\`trawl_report\` com rerender=true remonta só as seções automáticas).`,
          "",
          ...readList(id, pend),
          ...readRules(status.checking),
        );
      }
      break;
    }
  }
  return lines.filter((l) => l !== undefined).join("\n");
}
