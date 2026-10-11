import { config } from "../config.ts";
import { getJson, TTL } from "../core/http.ts";
import type { Connector, SearchHit, SearchQuery } from "../core/types.ts";
import { decodeEntities, isoDate } from "../core/util.ts";

interface Question {
  title: string;
  link: string;
  score: number;
  answer_count: number;
  view_count: number;
  is_answered: boolean;
  creation_date: number;
  tags?: string[];
  owner?: { display_name?: string };
}

export const stackexchange: Connector = {
  name: "stackexchange",
  label: "Stack Overflow / Stack Exchange",
  async availability() {
    return config.keys.stackexchange
      ? { ok: true, mode: "API com chave (10.000 req/dia)" }
      : { ok: true, mode: "API pública (300 req/dia por IP)", enable: "Opcional: STACKEXCHANGE_KEY grátis em stackapps.com sobe para 10.000/dia." };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    // "site:serverfault" style prefixes pick another Stack Exchange site.
    const siteMatch = /\bsite:(\S+)/.exec(q.query);
    const site = siteMatch?.[1] ?? "stackoverflow";
    const text = q.query.replace(/\bsite:\S+/, "").trim();
    const params = new URLSearchParams({
      order: "desc",
      sort: "relevance",
      q: text,
      site,
      pagesize: String(Math.min(q.limit, 50)),
    });
    if (q.sinceDays) params.set("fromdate", String(Math.floor(Date.now() / 1000 - q.sinceDays * 86400)));
    if (config.keys.stackexchange) params.set("key", config.keys.stackexchange);
    const data = await getJson<{ items: Question[]; quota_remaining?: number }>(
      `https://api.stackexchange.com/2.3/search/advanced?${params}`,
      { cacheTtlMs: TTL.search, signal: q.signal },
    );
    return data.items.map((i) => ({
      url: i.link,
      title: decodeEntities(i.title),
      source: "stackexchange",
      provider: site,
      published: isoDate(i.creation_date),
      author: i.owner?.display_name ? decodeEntities(i.owner.display_name) : undefined,
      metrics: { score: i.score, answers: i.answer_count, views: i.view_count },
      tags: [i.is_answered ? "respondida" : "sem resposta aceita", ...(i.tags ?? []).slice(0, 4)],
    }));
  },
};
