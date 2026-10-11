import { config } from "../config.ts";
import { getJson, TTL } from "../core/http.ts";
import type { Connector, SearchHit, SearchQuery } from "../core/types.ts";
import { isoDate, stripTags } from "../core/util.ts";

export const wikipedia: Connector = {
  name: "wikipedia",
  label: "Wikipedia",
  async availability() {
    return { ok: true, mode: `API pública, sem chave (idioma padrão: ${config.wikipediaLang})` };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    // "lang:pt" in the query picks the language edition.
    const langMatch = /\blang:([a-z-]{2,10})\b/.exec(q.query);
    const lang = langMatch?.[1] ?? config.wikipediaLang;
    const text = q.query.replace(/\blang:[a-z-]+\b/, "").trim();
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: text,
      srlimit: String(Math.min(q.limit, 20)),
      format: "json",
      utf8: "1",
    });
    const data = await getJson<{ query?: { search: Array<{ title: string; snippet: string; timestamp: string; wordcount: number }> } }>(
      `https://${lang}.wikipedia.org/w/api.php?${params}`,
      { cacheTtlMs: TTL.search, signal: q.signal },
    );
    return (data.query?.search ?? []).map((r) => ({
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
      title: r.title,
      snippet: stripTags(r.snippet),
      source: "wikipedia",
      provider: `wikipedia-${lang}`,
      published: isoDate(r.timestamp),
      tags: [`${r.wordcount} palavras`, "fonte terciária: siga as referências"],
    }));
  },
};
