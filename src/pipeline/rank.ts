import type { SearchHit, SourceName } from "../core/types.ts";
import { domainOf } from "../core/util.ts";
import { tokenize } from "../core/text.ts";

// One ranking across every source: relevance to the query, how much the source can be trusted,
// engagement (compared inside the same platform, since stars and likes are not the same unit)
// and freshness. A component a hit does not have (no date, no metrics) gets a neutral value
// instead of zero, so an undated documentation page is not punished.

export type Tier =
  | "oficial"
  | "governo"
  | "acadêmico"
  | "documentação"
  | "código"
  | "imprensa"
  | "referência"
  | "q&a"
  | "catálogo"
  | "site"
  | "fórum"
  | "blog"
  | "post"
  | "suspeito";

export const TIER_WEIGHT: Record<Tier, number> = {
  oficial: 1,
  governo: 0.95,
  acadêmico: 0.85,
  documentação: 0.85,
  código: 0.7,
  imprensa: 0.65,
  referência: 0.6,
  "q&a": 0.6,
  catálogo: 0.5,
  site: 0.5,
  fórum: 0.45,
  blog: 0.4,
  post: 0.35,
  suspeito: 0.05,
};

const PRESS = new Set(
  (
    "reuters.com apnews.com bloomberg.com ft.com wsj.com nytimes.com washingtonpost.com theguardian.com bbc.com bbc.co.uk cnn.com cnbc.com nbcnews.com " +
    "economist.com axios.com semafor.com politico.com theverge.com techcrunch.com arstechnica.com wired.com engadget.com zdnet.com venturebeat.com " +
    "theregister.com theinformation.com 404media.co platformer.news infoq.com businessinsider.com forbes.com fortune.com time.com newyorker.com " +
    "technologyreview.com spectrum.ieee.org nature.com/news gamesindustry.biz gamedeveloper.com polygon.com ign.com kotaku.com pcgamer.com eurogamer.net " +
    "folha.uol.com.br g1.globo.com oglobo.globo.com valor.globo.com estadao.com.br exame.com tecmundo.com.br olhardigital.com.br canaltech.com.br " +
    "tecnoblog.net uol.com.br bbc.com/portuguese elpais.com lemonde.fr spiegel.de heise.de nikkei.com scmp.com"
  ).split(" "),
);

const ACADEMIC = [
  "doi.org", "arxiv.org", "openalex.org", "nature.com", "science.org", "sciencedirect.com", "springer.com", "wiley.com", "acm.org", "ieee.org",
  "ncbi.nlm.nih.gov", "plos.org", "frontiersin.org", "aclanthology.org", "openreview.net", "semanticscholar.org", "biorxiv.org", "medrxiv.org",
  "ssrn.com", "jstor.org", "pnas.org", "cell.com", "thelancet.com", "nejm.org", "bmj.com", "papers.nips.cc", "proceedings.mlr.press",
];

const BLOGS = ["medium.com", "dev.to", "substack.com", "hashnode.dev", "hashnode.com", "blogspot.com", "wordpress.com", "tumblr.com", "beehiiv.com", "ghost.io", "linkedin.com"];

const SOCIAL: Record<string, Tier> = {
  "reddit.com": "fórum",
  "news.ycombinator.com": "fórum",
  "stackoverflow.com": "q&a",
  "x.com": "post",
  "twitter.com": "post",
  "youtube.com": "post",
  "youtu.be": "post",
  "tiktok.com": "post",
  "instagram.com": "post",
  "facebook.com": "post",
  "threads.net": "post",
  "bsky.app": "post",
  "wikipedia.org": "referência",
  "github.com": "código",
  "gitlab.com": "código",
};

const SOURCE_TIER: Partial<Record<SourceName, Tier>> = {
  reddit: "fórum",
  reddit_comments: "fórum",
  hn: "fórum",
  forums: "fórum",
  github_discussions: "fórum",
  x: "post",
  youtube: "post",
  github: "código",
  github_issues: "código",
  github_code: "código",
  arxiv: "acadêmico",
  openalex: "acadêmico",
  stackexchange: "q&a",
  wikipedia: "referência",
  mcp_registry: "catálogo",
  skillsmp: "catálogo",
};

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** How much a source can be trusted, from its platform, its domain and the session's official domains. */
export function trustTier(hit: Pick<SearchHit, "url" | "tags"> & { source: string }, officialDomains: string[] = []): Tier {
  if (hit.tags?.some((t) => t.includes("SUSPEITO"))) return "suspeito";
  const host = domainOf(hit.url).toLowerCase();
  let path = "";
  try {
    path = new URL(hit.url).pathname.toLowerCase();
  } catch {
    // keep empty
  }
  // "python.org" matches the domain and its subdomains; "github.com/astral-sh" matches that path.
  const official = officialDomains.some((d) => {
    const entry = d.toLowerCase().replace(/^www\./, "");
    const slash = entry.indexOf("/");
    if (slash < 0) return under(host, entry);
    return host === entry.slice(0, slash) && `${path}/`.startsWith(`${entry.slice(slash)}/`);
  });
  // Official sites also host player forums (board/free, Q&A, lounge): those are community voices.
  const community =
    /^(community|forums?|discuss|lounge|bbs)\./.test(host) ||
    /\/(free|qna|qnanknowhow|forums?|community|discussions?|threads?|users?|profile|bbs|lounge|feed)(\/|$)/.test(path);
  if (official) return community ? "fórum" : "oficial";
  // A game's announcement feed on Steam is posted by its developer or publisher.
  if ((host === "store.steampowered.com" && path.startsWith("/news/app/")) || (host === "api.steampowered.com" && path.startsWith("/isteamnews/"))) {
    return "oficial";
  }
  const bySource = SOURCE_TIER[hit.source as SourceName];
  if (bySource) return bySource;
  if (community) return "fórum";
  // Academic first: PubMed and other research hosts live under .gov domains.
  if (ACADEMIC.some((d) => under(host, d)) || /\.(edu|ac\.[a-z]{2})$/.test(host) || /\.edu\.[a-z]{2}$/.test(host)) return "acadêmico";
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(host) || /\.gob\.[a-z]{2}$/.test(host) || under(host, "europa.eu") || under(host, "who.int") || under(host, "un.org")) {
    return "governo";
  }
  for (const [d, tier] of Object.entries(SOCIAL)) if (under(host, d)) return tier;
  if (PRESS.has(host) || [...PRESS].some((p) => p.includes("/") ? `${host}${path}`.startsWith(p) : under(host, p))) return "imprensa";
  if (BLOGS.some((d) => under(host, d))) return "blog";
  if (
    /^(docs?|developers?|dev|learn|help|support|api|reference|manual|wiki)\./.test(host) ||
    /\.(readthedocs\.io|gitbook\.io)$/.test(host) ||
    under(host, "developer.mozilla.org") ||
    /^\/(docs?|documentation|reference|manual|api)(\/|$)/.test(path)
  ) {
    return "documentação";
  }
  if (/^\/blog(\/|$)/.test(path) || /^blog\./.test(host)) return "blog";
  return "site";
}

export function engagementValue(m: SearchHit["metrics"]): number | undefined {
  if (!m) return undefined;
  const parts = [m.score, m.likes, m.stars, m.comments, m.replies, m.reposts, m.views, m.answers, m.citations, m.forks];
  if (parts.every((p) => p === undefined)) return undefined;
  // Views are a weaker signal than a vote or a reply, so they count at 1/200.
  return (
    (m.score ?? 0) + (m.likes ?? 0) + (m.stars ?? 0) + 2 * ((m.comments ?? 0) + (m.replies ?? 0) + (m.answers ?? 0)) +
    3 * (m.reposts ?? 0) + 2 * (m.forks ?? 0) + (m.citations ?? 0) * 5 + (m.views ?? 0) / 200
  );
}

export interface RankOptions {
  /** Terms the hit should be about. */
  terms: string[];
  /** One term list per query variant: relevance is the best match among them, so a hit that
   * answers one variant fully is not diluted by the words of the other variants. */
  termSets?: string[][];
  sinceDays?: number;
  officialDomains?: string[];
  /** How many query variants returned each URL (more = more central to the topic). */
  queryHits?: Map<string, number>;
  queryCount?: number;
  now?: number;
}

export interface Ranked {
  hit: SearchHit;
  score: number;
  tier: Tier;
  /** `shared`: how many of the result set's common words (feedbackTerms) the hit uses. */
  parts: { relevance: number; trust: number; engagement?: number; recency?: number; shared?: number };
}

const WEIGHTS = { relevance: 0.4, trust: 0.25, engagement: 0.2, recency: 0.15 };
// Unknown engagement or date counts as a little below average, so a page with no metrics
// neither beats a well-voted thread nor gets buried; trust decides between them.
const UNKNOWN = { engagement: 0.3, recency: 0.4 };

/**
 * Words many results share that are not in the query: what the result set is about. A hit that
 * matched the query words but shares none of these is probably another meaning of the same
 * word ("uv" the Python tool versus UV light), a pseudo-relevance-feedback check.
 */
export function feedbackTerms(hits: SearchHit[], exclude: string[], max = 12): string[] {
  const ex = new Set(exclude);
  const df = new Map<string, number>();
  for (const h of hits) {
    for (const t of new Set(tokenize(`${h.title} ${h.snippet ?? ""}`.replace(/https?:\/\/\S+/g, " ")))) {
      if (!ex.has(t) && t.length > 2 && !/^\d+$/.test(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const min = Math.max(2, Math.ceil(hits.length * 0.05));
  return [...df]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

function relevance(hit: SearchHit, terms: string[]): number {
  if (!terms.length) return 0.5;
  const title = new Set(tokenize(hit.title));
  const body = new Set(tokenize(`${hit.snippet ?? ""} ${(hit.tags ?? []).join(" ")} ${hit.url}`));
  let s = 0;
  for (const t of terms) s += title.has(t) ? 1 : body.has(t) ? 0.6 : 0;
  return s / terms.length;
}

function recency(published: string | undefined, sinceDays: number | undefined, now: number): number | undefined {
  if (!published) return undefined;
  const t = Date.parse(published);
  if (Number.isNaN(t)) return undefined;
  const age = Math.max(0, (now - t) / 86_400_000);
  // Inside a window everything is recent by definition; age only breaks ties (1 → 0.5).
  if (sinceDays) return Math.max(0.5, 1 - (0.5 * age) / (sinceDays + 1));
  return 0.5 ** (age / 365);
}

/** Ranks hits from any mix of sources into a single list, best first. */
export function rankHits(hits: SearchHit[], opts: RankOptions): Ranked[] {
  const now = opts.now ?? Date.now();
  // Engagement percentile inside each platform, blended with an absolute log scale so a lone
  // result with 3 likes does not become "100th percentile".
  const bySource = new Map<string, number[]>();
  for (const h of hits) {
    const e = engagementValue(h.metrics);
    if (e !== undefined) bySource.set(h.source, [...(bySource.get(h.source) ?? []), e]);
  }
  for (const v of bySource.values()) v.sort((a, b) => a - b);
  const engagement = (h: SearchHit): number | undefined => {
    const e = engagementValue(h.metrics);
    if (e === undefined) return undefined;
    const vals = bySource.get(h.source)!;
    const pct = vals.length > 1 ? vals.filter((x) => x < e).length / (vals.length - 1) : 0.5;
    return 0.5 * pct + 0.5 * Math.min(1, Math.log10(1 + e) / 4);
  };

  const allTerms = [...new Set([...opts.terms, ...(opts.termSets ?? []).flat()])];
  const fb = hits.length >= 8 ? feedbackTerms(hits, allTerms) : [];
  const sharedWith = (hit: SearchHit): number | undefined => {
    if (fb.length < 3) return undefined;
    const toks = new Set(tokenize(`${hit.title} ${hit.snippet ?? ""}`));
    return fb.filter((t) => toks.has(t)).length;
  };
  // Two shared words are enough for short posts; none halves the relevance.
  const onTopic = (shared: number | undefined): number => (shared === undefined ? 1 : 0.5 + 0.5 * Math.min(1, shared / 2));

  return hits
    .map((hit) => {
      const tier = trustTier(hit, opts.officialDomains);
      const shared = sharedWith(hit);
      let rel = (opts.termSets?.length ? Math.max(...opts.termSets.map((t) => relevance(hit, t))) : relevance(hit, opts.terms)) * onTopic(shared);
      const qh = opts.queryHits?.get(hit.url);
      if (qh && (opts.queryCount ?? 1) > 1) rel = Math.min(1, 0.85 * rel + 0.15 * ((qh - 1) / ((opts.queryCount ?? 2) - 1)));
      const parts = { relevance: rel, trust: TIER_WEIGHT[tier], engagement: engagement(hit), recency: recency(hit.published, opts.sinceDays, now), shared };
      const sum =
        WEIGHTS.relevance * parts.relevance +
        WEIGHTS.trust * parts.trust +
        WEIGHTS.engagement * (parts.engagement ?? UNKNOWN.engagement) +
        WEIGHTS.recency * (parts.recency ?? UNKNOWN.recency);
      return { hit, tier, parts, score: Math.round(sum * 100) };
    })
    .sort((a, b) => b.score - a.score);
}

/** A "site" for diversity: the subreddit, repo or author, else the domain. */
export function siteKey(hit: Pick<SearchHit, "url" | "source" | "author" | "tags">): string {
  const host = domainOf(hit.url);
  if (hit.source === "reddit" || hit.source === "reddit_comments") return hit.tags?.find((t) => t.startsWith("r/")) ?? host;
  if (hit.source === "x" || hit.source === "youtube") return `${hit.source}:${hit.author ?? host}`;
  if (host === "github.com") return new URL(hit.url).pathname.split("/").slice(1, 3).join("/");
  return host;
}

/**
 * The best n hits worth reading in full: at most `perSite` from the same site and, on the first
 * pass, at most half from the same platform, so one source type cannot take every read.
 */
export function pickToRead(ranked: Ranked[], n: number, perSite = 1): Ranked[] {
  // Reading is the expensive part: only hits close to the most relevant one are worth it.
  const best = Math.max(0, ...ranked.map((r) => r.parts.relevance));
  const readable = ranked.filter((r) => r.hit.source !== "github_code" && r.tier !== "suspeito" && r.parts.relevance >= 0.6 * best);
  const out: Ranked[] = [];
  const count = new Map<string, number>();
  const perSource = new Map<string, number>();
  const sourceCap = Math.max(1, Math.ceil(n / 2));
  // Passes loosen the caps one at a time: site and platform, then only site, then none.
  for (const [siteCap, platformCap] of [[perSite, sourceCap], [perSite, Infinity], [Infinity, Infinity]] as const) {
    for (const r of readable) {
      if (out.length >= n) return out;
      if (out.includes(r)) continue;
      const k = siteKey(r.hit);
      if ((count.get(k) ?? 0) >= siteCap || (perSource.get(r.hit.source) ?? 0) >= platformCap) continue;
      count.set(k, (count.get(k) ?? 0) + 1);
      perSource.set(r.hit.source, (perSource.get(r.hit.source) ?? 0) + 1);
      out.push(r);
    }
  }
  return out;
}
