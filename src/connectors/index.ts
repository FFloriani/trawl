import type { Availability, Connector, SearchHit, SearchQuery, SourceName } from "../core/types.ts";
import { errMessage, normalizeUrl } from "../core/util.ts";
import { arxiv } from "./arxiv.ts";
import { mcpRegistry, skillsmp } from "./catalogs.ts";
import { forums } from "./forums.ts";
import { githubCode, githubDiscussions, githubIssues, githubRepos } from "./github.ts";
import { hackernews } from "./hackernews.ts";
import { openalex } from "./openalex.ts";
import { redditComments } from "./reddit-comments.ts";
import { reddit } from "./reddit.ts";
import { stackexchange } from "./stackexchange.ts";
import { searchWebAll, web } from "./web.ts";
import { wikipedia } from "./wikipedia.ts";
import { x } from "./x.ts";
import { youtube } from "./youtube.ts";

export const CONNECTORS: Record<SourceName, Connector> = {
  web,
  reddit,
  reddit_comments: redditComments,
  hn: hackernews,
  x,
  github: githubRepos,
  github_issues: githubIssues,
  github_code: githubCode,
  github_discussions: githubDiscussions,
  arxiv,
  openalex,
  stackexchange,
  wikipedia,
  forums,
  youtube,
  mcp_registry: mcpRegistry,
  skillsmp,
};

/** Which sources answer each kind of question in a research plan. */
export const LAYERS = {
  official: { label: "web: sites oficiais, guias e bases de dados", sources: ["web"] },
  community: { label: "o que pessoas reais dizem", sources: ["reddit", "reddit_comments", "hn", "x", "forums", "youtube", "github_discussions"] },
  code: { label: "projetos e código", sources: ["github", "github_issues", "github_code"] },
  tools: { label: "catálogos de MCPs e skills", sources: ["mcp_registry", "skillsmp", "github"] },
  academic: { label: "estudos e artigos", sources: ["openalex", "arxiv"] },
  qa: { label: "perguntas técnicas resolvidas", sources: ["stackexchange"] },
  reference: { label: "visão geral e referências", sources: ["wikipedia"] },
} as const satisfies Record<string, { label: string; sources: SourceName[] }>;

export type LayerName = keyof typeof LAYERS;
export const LAYER_NAMES = Object.keys(LAYERS) as LayerName[];

export interface SourceReport {
  count: number;
  ms: number;
  error?: string;
  /** Hits dropped because their date fell outside since_days. */
  outOfWindow?: number;
}

export interface FanoutResult {
  hits: SearchHit[];
  report: Partial<Record<SourceName, SourceReport>>;
}

export interface FanoutOptions {
  query: string;
  sources: SourceName[];
  limit: number;
  sinceDays?: number;
  /** Per-source query override, e.g. GitHub qualifiers or "site:serverfault". */
  queries?: Partial<Record<SourceName, string>>;
  /** Per-source result count, e.g. more for the free local web search. */
  limits?: Partial<Record<SourceName, number>>;
  webAll?: boolean;
  timeoutMs?: number;
  /** Discourse hosts for the "forums" source (chosen per research). */
  forums?: string[];
}

/**
 * Safety net for since_days: some APIs filter by coarse buckets (Reddit "month", YouTube
 * "this month"), so every dated hit is re-checked. Approximate dates ("2w ago") get the
 * granularity of their unit as slack; undated hits are kept.
 */
export function insideWindow(hit: SearchHit, sinceDays: number, now = Date.now()): boolean {
  if (!hit.published) return true;
  const t = Date.parse(hit.published);
  if (Number.isNaN(t)) return true;
  const approx = hit.tags?.some((tag) => tag.startsWith("data aproximada")) ?? false;
  const slackDays = approx ? Math.max(2, sinceDays * 0.25) : 1;
  return now - t <= (sinceDays + slackDays) * 86_400_000;
}

/** Searches several sources in parallel. One failing source never sinks the others. */
export async function fanout(opts: FanoutOptions): Promise<FanoutResult> {
  const report: FanoutResult["report"] = {};
  const unique = [...new Set(opts.sources)];
  const results = await Promise.all(
    unique.map(async (name) => {
      const started = Date.now();
      const signal = AbortSignal.timeout(opts.timeoutMs ?? (name === "x" ? 130_000 : 50_000));
      let query = opts.queries?.[name] ?? opts.query;
      if (name === "forums" && opts.forums?.length && !/\bforum:\S/.test(query)) query += " " + opts.forums.map((f) => `forum:${f}`).join(" ");
      const q: SearchQuery = { query, limit: opts.limits?.[name] ?? opts.limit, sinceDays: opts.sinceDays, signal };
      try {
        let hits: SearchHit[];
        if (name === "web" && opts.webAll) {
          const r = await searchWebAll(q);
          hits = r.hits;
          if (r.errors.length) report.web = { count: 0, ms: 0, error: r.errors.join(" | ") };
        } else {
          hits = await CONNECTORS[name].search(q);
        }
        const kept = opts.sinceDays ? hits.filter((h) => insideWindow(h, opts.sinceDays!)) : hits;
        report[name] = {
          ...report[name],
          count: kept.length,
          ms: Date.now() - started,
          ...(kept.length < hits.length ? { outOfWindow: hits.length - kept.length } : {}),
        };
        return kept;
      } catch (err) {
        report[name] = { count: 0, ms: Date.now() - started, error: errMessage(err) };
        return [];
      }
    }),
  );
  const seen = new Map<string, SearchHit>();
  for (const hit of results.flat()) {
    const key = normalizeUrl(hit.url);
    if (!seen.has(key)) seen.set(key, hit);
  }
  return { hits: [...seen.values()], report };
}

export async function availabilityAll(): Promise<Array<{ name: SourceName; label: string } & Availability>> {
  return Promise.all(
    (Object.keys(CONNECTORS) as SourceName[]).map(async (name) => {
      const c = CONNECTORS[name];
      try {
        return { name, label: c.label, ...(await c.availability()) };
      } catch (err) {
        return { name, label: c.label, ok: false, mode: "erro", note: errMessage(err) };
      }
    }),
  );
}
