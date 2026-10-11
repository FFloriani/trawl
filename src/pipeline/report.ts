import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Marked } from "marked";
import { VERSION } from "../config.ts";
import type { Metrics } from "../core/types.ts";
import { compactNumber, domainOf, slugify } from "../core/util.ts";
import { layerOf } from "./phases.ts";
import type { SessionData, SourceRecord } from "./session.ts";

export interface ReportInput {
  title: string;
  summary: string;
  sections: Array<{ heading: string; body: string }>;
  conclusion?: string;
  outputDir?: string;
}

export interface RenderedReport {
  md: string;
  html: string;
  cited: string[];
  warnings: string[];
}

// Loose on purpose: a malformed id like [S12ab] must be caught, not silently left as text.
const CITATION = /\[(S[0-9a-z]{4,10}(?:\s*[,;]\s*S[0-9a-z]{4,10})*)\]/gi;

export function findCitations(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(CITATION)) {
    for (const id of m[1]!.split(/\s*[,;]\s*/)) ids.push(id);
  }
  return ids;
}

export function metricsText(m: Metrics | undefined): string {
  if (!m) return "";
  const parts = [
    m.score !== undefined ? `▲${compactNumber(m.score)}` : "",
    m.likes !== undefined ? `♥${compactNumber(m.likes)}` : "",
    m.stars !== undefined ? `★${compactNumber(m.stars)}` : "",
    m.comments !== undefined ? `${compactNumber(m.comments)} coment.` : "",
    m.replies !== undefined ? `${compactNumber(m.replies)} resp.` : "",
    m.answers !== undefined ? `${m.answers} respostas` : "",
    m.citations !== undefined ? `${compactNumber(m.citations)} citações` : "",
    m.views !== undefined ? `${compactNumber(m.views)} views` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

function engagement(s: SourceRecord): number {
  const m = s.metrics ?? {};
  // Views are a weaker signal than a vote or a reply, so they count at 1/200.
  return (m.score ?? 0) + (m.likes ?? 0) + 2 * ((m.comments ?? 0) + (m.replies ?? 0)) + 3 * (m.reposts ?? 0) + (m.views ?? 0) / 200;
}

function sourceLabel(s: SourceRecord): string {
  const where =
    s.tags?.find((t) => t.startsWith("r/")) ??
    (s.source === "hn" ? "Hacker News" : s.source === "x" ? "X" : s.source === "youtube" ? `YouTube (${s.author ?? "?"})` : domainOf(s.url));
  return where;
}

export function renderReport(data: SessionData, input: ReportInput): RenderedReport {
  const warnings: string[] = [];
  const allText = [input.summary, ...input.sections.map((s) => s.body), input.conclusion ?? ""].join("\n");
  const ids = findCitations(allText);
  const unknown = [...new Set(ids.filter((id) => !data.sources.has(id)))];
  if (unknown.length) {
    throw new Error(
      `Relatório recusado: ${unknown.length} citação(ões) com id desconhecido: ${unknown.join(", ")}. Cite só fontes registradas (trawl_search, trawl_read ou trawl_add_sources).`,
    );
  }

  const order: string[] = [];
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const num = new Map(order.map((id, i) => [id, i + 1]));
  const cite = (text: string) =>
    text.replace(CITATION, (_m, group: string) =>
      group
        .split(/\s*[,;]\s*/)
        .map((id) => `[[${num.get(id)}]](${data.sources.get(id)!.url})`)
        .join(""),
    );

  if (!order.length) warnings.push("O relatório não cita nenhuma fonte.");
  const falseClaims = [...data.verifications.values()].filter((v) => v.verdict === "false");
  if (falseClaims.length) {
    warnings.push(`Confira se o texto não repete achados marcados como falsos: ${falseClaims.map((v) => v.claim).join(", ")}.`);
  }

  const { meta } = data;
  const verifs = [...data.verifications.values()];
  const count = (v: string) => verifs.filter((x) => x.verdict === v).length;
  const md: string[] = [`# ${input.title}`, ""];
  md.push(`_Pergunta: ${meta.question}_  `, `_Gerado em ${new Date().toISOString().slice(0, 10)} pelo Trawl ${VERSION} · profundidade ${meta.depth}_`, "");
  if (verifs.length) {
    const literal = verifs.filter((v) => v.quote && v.quote.checked !== "unreadable").length;
    md.push(
      `> **Verificação:** ${verifs.length === 1 ? "1 achado conferido" : `${verifs.length} achados conferidos`} na fonte original: ${count("confirmed")} confirmado(s), ${count("corrected")} corrigido(s), ${count("unverified")} sem prova, ${count("false")} falso(s).${literal ? ` ${literal} com citação literal conferida pelo servidor no texto da fonte.` : ""}`,
      "",
    );
  }
  md.push(cite(input.summary.trim()), "");
  for (const s of input.sections) md.push(`## ${s.heading.trim()}`, "", cite(s.body.trim()), "");

  // Only discussions the research actually used (cited or behind a finding) and, when the
  // session has a window, only those inside it: raw engagement alone surfaces noise.
  const used = new Set([...order, ...[...data.claims.values()].flatMap((c) => c.sources)]);
  const cutoff = meta.sinceDays ? Date.now() - (meta.sinceDays + 1) * 86_400_000 : undefined;
  const community = [...data.sources.values()]
    .filter((s) => layerOf(s) === "community" && engagement(s) > 0 && used.has(s.id))
    .filter((s) => cutoff === undefined || !s.published || Date.parse(s.published) >= cutoff)
    .sort((a, b) => engagement(b) - engagement(a))
    .slice(0, 8);
  if (community.length) {
    md.push("## O que a comunidade diz", "", "_Engajamento mede atenção, não verdade. Use como sinal de opinião e experiência de uso._", "");
    for (const s of community) {
      md.push(`- ${sourceLabel(s)} · ${metricsText(s.metrics)} · ${s.published?.slice(0, 10) ?? ""}: [${s.title.replace(/[[\]]/g, "")}](${s.url})`);
    }
    md.push("");
  }

  if (input.conclusion?.trim()) md.push("## Conclusão", "", cite(input.conclusion.trim()), "");

  if (verifs.length) {
    const text = (claimId: string) => data.claims.get(claimId)?.text ?? claimId;
    // The excerpt that proves it, linked to its source, so a reader can check in one click.
    const proof = (v: (typeof verifs)[number]) => {
      if (!v.quote) return "";
      const s = data.sources.get(v.quote.source);
      const q = v.quote.text.length > 300 ? v.quote.text.slice(0, 300) + "…" : v.quote.text;
      return `\n  > “${q.replace(/\s+/g, " ")}” (${s ? `[${domainOf(s.url)}](${s.url})` : v.quote.source})`;
    };
    const confirmed = verifs.filter((v) => v.verdict === "confirmed");
    const corrected = verifs.filter((v) => v.verdict === "corrected");
    const avoid = verifs.filter((v) => v.verdict === "unverified" || v.verdict === "false");
    md.push("## Guia de afirmações", "");
    if (confirmed.length) md.push("**Pode afirmar**", ...confirmed.map((v) => `- ${text(v.claim)}${proof(v)}`), "");
    if (corrected.length) md.push("**Afirme com a correção**", ...corrected.map((v) => `- ${v.correctedText ?? text(v.claim)}${v.note ? ` (${v.note})` : ""}${proof(v)}`), "");
    if (avoid.length) {
      md.push("**Evite**", ...avoid.map((v) => `- ${text(v.claim)} (${v.verdict === "false" ? "falso" : "sem prova"}${v.note ? `: ${v.note}` : ""})`), "");
    }
  }

  if (data.gaps.length) {
    md.push("## Lacunas", "");
    for (const g of data.gaps) md.push(`- ${g.subquestion}: ${g.text}`);
    md.push("");
  }

  const byKind = new Map<string, number>();
  for (const s of data.sources.values()) byKind.set(s.source, (byKind.get(s.source) ?? 0) + 1);
  md.push(
    "## Metodologia",
    "",
    `- Sub-perguntas: ${(meta.plan?.subquestions ?? []).map((s) => `${s.id} ${s.question} [${s.layers.join(", ")}]`).join("; ")}`,
    `- Fontes registradas: ${data.sources.size} (${[...byKind].map(([k, v]) => `${k} ${v}`).join(", ")}); lidas na íntegra: ${[...data.sources.values()].filter((s) => s.readAt).length}`,
    `- Achados: ${data.claims.size}; verificados: ${verifs.length}`,
    meta.sinceDays ? `- Janela: últimos ${meta.sinceDays} dias` : "- Janela: sem limite de data",
    "",
  );

  md.push("## Fontes", "");
  order.forEach((id, i) => {
    const s = data.sources.get(id)!;
    const bits = [s.author, domainOf(s.url), s.published?.slice(0, 10), metricsText(s.metrics)].filter(Boolean).join(" · ");
    md.push(`${i + 1}. [${s.title.replace(/[[\]]/g, "")}](${s.url}) (${bits}) \`${id}\``);
  });
  const uncited = data.sources.size - order.length;
  if (uncited > 0) md.push("", `_Outras ${uncited} fontes foram coletadas e não citadas; estão em sources.jsonl._`);

  const markdown = md.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  return { md: markdown, html: toHtml(input.title, markdown), cited: order, warnings };
}

const CSS = `
:root{--bg:#fbfbfa;--fg:#1d1d1f;--muted:#6e6e73;--accent:#2457c5;--card:#fff;--border:#e3e3e0}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--muted:#a1a1a8;--accent:#7aa2ff;--card:#1c1c20;--border:#2c2c32}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:780px;margin:0 auto;padding:40px 20px 80px}h1{font-size:1.9rem;line-height:1.25;margin:0 0 .4rem}
h2{font-size:1.25rem;margin:2.2rem 0 .6rem;padding-top:.6rem;border-top:1px solid var(--border)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
blockquote{margin:1rem 0;padding:.8rem 1rem;background:var(--card);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:8px}
code{font:13px ui-monospace,Consolas,monospace;color:var(--muted)}em{color:var(--muted)}li{margin:.25rem 0}
table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--border);padding:6px 8px;text-align:left}
`;

const escapeHtml = (text: string) => text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

// Titles and snippets come from the open web, so raw HTML in the Markdown is shown as text,
// never rendered: a hostile page title cannot run script in the report.
const markdownToHtml = new Marked({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

function toHtml(title: string, markdown: string): string {
  const body = markdownToHtml.parse(markdown, { async: false }) as string;
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export async function writeReport(
  data: SessionData,
  rendered: RenderedReport,
  title: string,
  outputDir?: string,
  input?: ReportInput,
): Promise<{ md: string; html: string; copies: string[] }> {
  const md = join(data.dir, "report.md");
  const html = join(data.dir, "report.html");
  await writeFile(md, rendered.md);
  await writeFile(html, rendered.html);
  // Kept so the report can be re-rendered (trawl_report with rerender=true) after fixes or new verifications.
  if (input) await writeFile(join(data.dir, "report-input.json"), JSON.stringify(input, null, 2));
  const copies: string[] = [];
  if (outputDir) {
    const dir = resolve(outputDir);
    await mkdir(dir, { recursive: true });
    const base = slugify(title, 60);
    for (const [ext, content] of [["md", rendered.md], ["html", rendered.html]] as const) {
      const file = join(dir, `${base}.${ext}`);
      await writeFile(file, content);
      copies.push(file);
    }
  }
  return { md, html, copies };
}
