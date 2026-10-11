import { XMLParser } from "fast-xml-parser";
import { request, TTL } from "../core/http.ts";
import type { Connector, ReadResult, SearchHit, SearchQuery } from "../core/types.ts";
import { isoDate, oneLine } from "../core/util.ts";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["entry", "author", "link", "category"].includes(name),
});

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published?: string;
  updated?: string;
  author?: Array<{ name: string }>;
  category?: Array<{ "@_term": string }>;
  "arxiv:journal_ref"?: string | { "#text"?: string };
  "arxiv:comment"?: string | { "#text"?: string };
}

const text = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "object" && v && "#text" in v ? String((v as { "#text": unknown })["#text"]) : "";

export function parseArxiv(body: string): ArxivEntry[] {
  const doc = xml.parse(body) as { feed?: { entry?: ArxivEntry[] } };
  return doc.feed?.entry ?? [];
}

// arXiv search syntax: every word must appear (AND), phrases in quotes stay together.
export function arxivQuery(query: string): string {
  const parts = query.match(/"[^"]+"|\S+/g) ?? [];
  return parts
    .slice(0, 8)
    .map((p) => `all:${p.replace(/[()]/g, "")}`)
    .join(" AND ");
}

function toHit(e: ArxivEntry): SearchHit {
  const authors = (e.author ?? []).map((a) => a.name);
  return {
    url: e.id.replace(/^http:/, "https:").replace(/v\d+$/, ""),
    title: oneLine(e.title, 300),
    snippet: oneLine(e.summary, 400),
    source: "arxiv",
    provider: "arxiv-api",
    published: isoDate(e.published),
    author: authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", "),
    tags: [
      ...(e.category ?? []).slice(0, 3).map((c) => c["@_term"]),
      text(e["arxiv:journal_ref"]) ? `publicado: ${oneLine(text(e["arxiv:journal_ref"]), 80)}` : "preprint",
    ],
  };
}

export const arxiv: Connector = {
  name: "arxiv",
  label: "arXiv",
  async availability() {
    return { ok: true, mode: "API pública, sem chave (1 req a cada 3 s)" };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    // Relevance first, then the date window: sorting by date alone surfaces papers that merely
    // contain the words. Over-fetch so enough relevant papers survive the window.
    const params = new URLSearchParams({
      search_query: arxivQuery(q.query),
      start: "0",
      max_results: String(q.sinceDays ? 100 : Math.min(q.limit, 100)),
      sortBy: "relevance",
      sortOrder: "descending",
    });
    const res = await request(`https://export.arxiv.org/api/query?${params}`, { cacheTtlMs: TTL.search, signal: q.signal });
    let hits = parseArxiv(res.text).map(toHit);
    if (q.sinceDays) {
      const cutoff = Date.now() - q.sinceDays * 86_400_000;
      hits = hits.filter((h) => !h.published || Date.parse(h.published) >= cutoff);
    }
    return hits.slice(0, q.limit);
  },
};

export function arxivIdFromUrl(url: string): string | undefined {
  return /arxiv\.org\/(?:abs|pdf)\/([^/?#]+?)(?:v\d+)?(?:\.pdf)?(?:[?#]|$)/i.exec(url)?.[1];
}

export async function readArxiv(id: string): Promise<ReadResult> {
  const res = await request(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, { cacheTtlMs: TTL.page });
  const e = parseArxiv(res.text)[0];
  if (!e) throw new Error(`arXiv ${id} não encontrado`);
  const hit = toHit(e);
  return {
    url: hit.url,
    title: hit.title,
    source: "arxiv",
    published: hit.published,
    author: (e.author ?? []).map((a) => a.name).join(", "),
    content: [
      `Autores: ${(e.author ?? []).map((a) => a.name).join(", ")}`,
      `Categorias: ${(e.category ?? []).map((c) => c["@_term"]).join(", ")}`,
      `Status: ${hit.tags?.at(-1) ?? ""}`,
      text(e["arxiv:comment"]) ? `Comentário dos autores: ${oneLine(text(e["arxiv:comment"]), 300)}` : "",
      `PDF: https://arxiv.org/pdf/${id}`,
      "",
      "## Resumo",
      e.summary.replace(/\s+/g, " ").trim(),
    ]
      .filter((l, i) => l !== "" || i > 3)
      .join("\n"),
    note: "Só o resumo. Para o texto completo, leia o PDF ou a versão HTML (arxiv.org/html/<id>).",
  };
}
