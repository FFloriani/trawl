import { config } from "../config.ts";
import { getJson, TTL } from "../core/http.ts";
import type { Connector, SearchHit, SearchQuery } from "../core/types.ts";
import { daysAgoDate, isoDate, oneLine, ymd } from "../core/util.ts";

interface Work {
  id: string;
  doi?: string | null;
  display_name?: string;
  publication_date?: string;
  cited_by_count?: number;
  type?: string;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { landing_page_url?: string | null; source?: { display_name?: string } | null } | null;
  open_access?: { oa_url?: string | null; is_oa?: boolean };
  abstract_inverted_index?: Record<string, number[]> | null;
}

/** OpenAlex ships abstracts as an inverted index (word → positions). */
export function rebuildAbstract(index: Record<string, number[]> | null | undefined, maxWords = 90): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) if (p < maxWords) words[p] = word;
  }
  return words.filter(Boolean).join(" ");
}

export const openalex: Connector = {
  name: "openalex",
  label: "OpenAlex (artigos científicos e citações)",
  async availability() {
    return {
      ok: true,
      mode: config.keys.openalex ? "API com chave" : "API pública, sem chave",
      enable: config.contactEmail ? undefined : "Opcional: defina TRAWL_CONTACT_EMAIL para entrar no pool educado (mais estável).",
    };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const params = new URLSearchParams({ search: q.query, "per-page": String(Math.min(q.limit, 50)) });
    if (q.sinceDays) params.set("filter", `from_publication_date:${ymd(daysAgoDate(q.sinceDays))}`);
    if (config.contactEmail) params.set("mailto", config.contactEmail);
    if (config.keys.openalex) params.set("api_key", config.keys.openalex);
    const data = await getJson<{ results: Work[] }>(`https://api.openalex.org/works?${params}`, { cacheTtlMs: TTL.search, signal: q.signal });
    return data.results.map((w) => {
      const authors = (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean) as string[];
      const venue = w.primary_location?.source?.display_name;
      return {
        url: w.doi ?? w.primary_location?.landing_page_url ?? w.id,
        title: w.display_name ?? "(sem título)",
        snippet: oneLine(rebuildAbstract(w.abstract_inverted_index), 400),
        source: "openalex",
        provider: "openalex",
        published: isoDate(w.publication_date),
        author: authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", "),
        metrics: { citations: w.cited_by_count },
        tags: [w.type ?? "", venue ?? "", w.open_access?.oa_url ? `acesso aberto: ${w.open_access.oa_url}` : ""].filter(Boolean),
      };
    });
  },
};
