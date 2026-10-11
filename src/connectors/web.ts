import { config } from "../config.ts";
import { getJson, TTL } from "../core/http.ts";
import { log } from "../core/log.ts";
import type { Availability, Connector, SearchHit, SearchQuery } from "../core/types.ts";
import { daysAgoDate, errMessage, isoDate, oneLine } from "../core/util.ts";

// General web search has no reliable keyless backend (DuckDuckGo answers bots with a CAPTCHA,
// which we never bypass). The free route is a local SearXNG (docker/searxng, `npm run searxng`);
// keyed providers are the alternative. With none, the pipeline asks the host IDE to use its own
// web search tool and register the results through trawl_add_sources.

type Range = "day" | "week" | "month" | "year";

function range(days?: number): Range | undefined {
  if (!days) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 366) return "year";
  return undefined;
}

interface Provider {
  id: string;
  enabled(): boolean;
  search(q: SearchQuery): Promise<SearchHit[]>;
}

const hit = (provider: string, url: string, title: string, snippet?: string, published?: string, author?: string): SearchHit => ({
  url,
  title: oneLine(title, 300) || url,
  snippet: oneLine(snippet, 400),
  source: "web",
  provider,
  published: isoDate(published),
  author,
});

/**
 * Google-style snippets start with the date ("Oct 18, 2025 ... text" or "3 days ago ... text").
 * Pulling it out lets the time window drop old pages that came without a date field.
 */
export function snippetDate(snippet: string | undefined, now = Date.now()): { published?: string; snippet?: string; approx?: boolean } {
  if (!snippet) return { snippet };
  const abs = /^\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*(?:\.\.\.|…|-|—)\s*/.exec(snippet);
  if (abs) {
    const t = Date.parse(abs[1]!.replace(".", ""));
    if (!Number.isNaN(t)) return { published: new Date(t).toISOString(), snippet: snippet.slice(abs[0].length) };
  }
  const rel = /^\s*(\d+) (minute|hour|day|week|month|year)s? ago\s*(?:\.\.\.|…|-|—)\s*/i.exec(snippet);
  if (rel) {
    const unit = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 30 * 86_400_000, year: 365 * 86_400_000 }[
      rel[2]!.toLowerCase() as "minute"
    ];
    const coarse = /month|year/i.test(rel[2]!);
    return { published: new Date(now - Number(rel[1]) * unit).toISOString(), snippet: snippet.slice(rel[0].length), approx: coarse };
  }
  return { snippet };
}

const searxng: Provider = {
  id: "searxng",
  enabled: () => Boolean(config.keys.searxngUrl),
  async search(q) {
    const params = new URLSearchParams({ q: q.query, format: "json", categories: "general" });
    const r = range(q.sinceDays);
    if (r) params.set("time_range", r);
    const base = config.keys.searxngUrl!.replace(/\/+$/, "");
    const data = await getJson<{ results: Array<{ url: string; title: string; content?: string; publishedDate?: string; engines?: string[] }> }>(
      `${base}/search?${params}`,
      { cacheTtlMs: TTL.search, signal: q.signal },
    );
    return data.results.slice(0, q.limit).map((x) => {
      const d = x.publishedDate ? { snippet: x.content } : snippetDate(x.content);
      const h = hit("searxng", x.url, x.title, d.snippet, x.publishedDate ?? d.published);
      h.tags = [...(x.engines?.length ? [`motores: ${x.engines.join(",")}`] : []), ...(d.approx ? ["data aproximada"] : [])];
      if (!h.tags.length) delete h.tags;
      return h;
    });
  },
};

const brave: Provider = {
  id: "brave",
  enabled: () => Boolean(config.keys.brave),
  async search(q) {
    const params = new URLSearchParams({ q: q.query, count: String(Math.min(q.limit, 20)) });
    const fresh = { day: "pd", week: "pw", month: "pm", year: "py" } as const;
    const r = range(q.sinceDays);
    if (r) params.set("freshness", fresh[r]);
    const data = await getJson<{ web?: { results: Array<{ url: string; title: string; description?: string; page_age?: string; age?: string }> } }>(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      { headers: { "x-subscription-token": config.keys.brave! }, cacheTtlMs: TTL.search, signal: q.signal },
    );
    return (data.web?.results ?? []).map((x) => hit("brave", x.url, x.title, x.description?.replace(/<[^>]+>/g, ""), x.page_age));
  },
};

const tavily: Provider = {
  id: "tavily",
  enabled: () => Boolean(config.keys.tavily),
  async search(q) {
    const data = await getJson<{ results: Array<{ url: string; title: string; content?: string; published_date?: string }> }>(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.keys.tavily}` },
        json: {
          query: q.query,
          max_results: Math.min(q.limit, 20),
          search_depth: "basic",
          include_answer: false,
          ...(range(q.sinceDays) ? { time_range: range(q.sinceDays) } : {}),
        },
        cacheTtlMs: TTL.search,
        signal: q.signal,
      },
    );
    return data.results.map((x) => hit("tavily", x.url, x.title, x.content, x.published_date));
  },
};

const exa: Provider = {
  id: "exa",
  enabled: () => Boolean(config.keys.exa),
  async search(q) {
    const data = await getJson<{ results: Array<{ url: string; title?: string; text?: string; publishedDate?: string; author?: string }> }>(
      "https://api.exa.ai/search",
      {
        method: "POST",
        headers: { "x-api-key": config.keys.exa! },
        json: {
          query: q.query,
          numResults: Math.min(q.limit, 25),
          type: "auto",
          contents: { text: { maxCharacters: 400 } },
          ...(q.sinceDays ? { startPublishedDate: daysAgoDate(q.sinceDays).toISOString() } : {}),
        },
        cacheTtlMs: TTL.search,
        signal: q.signal,
      },
    );
    return data.results.map((x) => hit("exa", x.url, x.title ?? x.url, x.text, x.publishedDate, x.author ?? undefined));
  },
};

const ALL: Record<string, Provider> = { searxng, brave, tavily, exa };

let searxngHealth: { at: number; up: boolean; error?: string } | undefined;

/** Whether the configured SearXNG answers, cached one minute (availability runs on every search). */
async function searxngUp(): Promise<{ up: boolean; error?: string }> {
  if (searxngHealth && Date.now() - searxngHealth.at < 60_000) return searxngHealth;
  const base = config.keys.searxngUrl!.replace(/\/+$/, "");
  // Body drained and timer cleared right away: a pending abort or open body at exit trips a
  // libuv assertion on Windows.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(`${base}/healthz`, { signal: ctl.signal });
    await res.arrayBuffer().catch(() => undefined);
    searxngHealth = { at: Date.now(), up: true };
  } catch (err) {
    searxngHealth = { at: Date.now(), up: false, error: errMessage(err) };
  } finally {
    clearTimeout(timer);
  }
  return searxngHealth;
}

export function webProviders(): Provider[] {
  return config.webProviders.map((id) => ALL[id]).filter((p): p is Provider => Boolean(p?.enabled()));
}

/** Every configured provider at once, for diversity (costs one call per provider). */
export async function searchWebAll(q: SearchQuery): Promise<{ hits: SearchHit[]; errors: string[] }> {
  const providers = webProviders();
  const settled = await Promise.allSettled(providers.map((p) => p.search(q)));
  const hits: SearchHit[] = [];
  const errors: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") hits.push(...s.value);
    else errors.push(`${providers[i]?.id}: ${errMessage(s.reason)}`);
  });
  return { hits, errors };
}

export const web: Connector = {
  name: "web",
  label: "Busca web",
  async availability(): Promise<Availability> {
    let active = webProviders().map((p) => p.id);
    let down = "";
    if (active.includes("searxng") && !(await searxngUp()).up) {
      active = active.filter((id) => id !== "searxng");
      down = `SearXNG fora do ar em ${config.keys.searxngUrl}: rode \`npm run searxng\` na pasta do Trawl (precisa do Docker aberto)`;
    }
    if (active.length) return { ok: true, mode: `provedores: ${active.join(" → ")} (failover nessa ordem)`, ...(down ? { note: down } : {}) };
    if (down) return { ok: false, mode: "SearXNG configurado, mas fora do ar", note: down };
    return {
      ok: false,
      mode: "nenhum provedor configurado",
      note: "Sem provedor, use a busca web nativa da sua IDE e registre os achados com trawl_add_sources.",
      enable:
        "Grátis: `npm run searxng` sobe um SearXNG local no Docker e liga sozinho. Ou defina no .env da pasta de dados (trawl_doctor mostra onde): BRAVE_API_KEY, TAVILY_API_KEY ou EXA_API_KEY.",
    };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const providers = webProviders();
    if (!providers.length) throw new Error("nenhum provedor de busca web configurado (veja trawl_doctor)");
    const errors: string[] = [];
    for (const p of providers) {
      try {
        const hits = await p.search(q);
        if (hits.length) return hits;
      } catch (err) {
        errors.push(`${p.id}: ${errMessage(err)}`);
        log.warn(`web provider ${p.id} failed`, errMessage(err));
      }
    }
    if (errors.length) throw new Error(errors.join(" | "));
    return [];
  },
};
