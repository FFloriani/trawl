import { config } from "../config.ts";
import { getJson, TTL } from "../core/http.ts";
import type { SearchHit, SearchQuery } from "../core/types.ts";
import { compactNumber, errMessage, isoDate, oneLine } from "../core/util.ts";

// twitterapi.io: cheap reseller (~US$0.15 per 1,000 posts, measured 2026-10-11). Uses X's own
// advanced-search syntax and returns full engagement metrics. Billed per post returned
// (20 per page), so search fetches only the pages the limit needs. The provider collects the
// data itself; the tool never touches X's anti-bot checks or the user's X account.

const TWAPI = "https://api.twitterapi.io";

export interface TwapiTweet {
  id: string;
  text: string;
  createdAt?: string;
  lang?: string;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  quoteCount?: number;
  viewCount?: number;
  isReply?: boolean;
  author?: { userName?: string; name?: string; followers?: number; isBlueVerified?: boolean };
}

const headers = () => ({ "x-api-key": config.keys.twitterapiIo! });

export function twapiToHit(t: TwapiTweet): SearchHit {
  const user = t.author?.userName;
  return {
    url: `https://x.com/${user ?? "i"}/status/${t.id}`,
    title: oneLine(t.text, 140),
    snippet: oneLine(t.text, 400),
    source: "x",
    provider: "twitterapi.io",
    published: isoDate(t.createdAt),
    author: user ? `@${user}` : undefined,
    metrics: { likes: t.likeCount, reposts: t.retweetCount, replies: t.replyCount, views: t.viewCount },
    tags: [
      t.lang && t.lang !== "zxx" ? `lang:${t.lang}` : "",
      t.author?.followers !== undefined ? `${compactNumber(t.author.followers)} seguidores` : "",
      t.author?.isBlueVerified ? "selo azul" : "",
      t.isReply ? "resposta" : "",
    ].filter(Boolean),
  };
}

/** The window goes in as since_time (unix); "sort:latest" switches from Top to Latest. */
export function twapiQuery(query: string, sinceDays?: number, now = Date.now()): { query: string; queryType: "Top" | "Latest" } {
  const latest = /\bsort:latest\b/i.test(query);
  let q = query.replace(/\bsort:(latest|top)\b/gi, "").replace(/\s+/g, " ").trim();
  if (!/filter:retweets|include:nativeretweets/i.test(q)) q += " -filter:retweets";
  // Rounded down to the day: the same search repeated that day hits the disk cache instead of
  // being billed again (an exact-second timestamp made every request unique).
  if (sinceDays && !/\bsince(_time)?:/i.test(q)) q += ` since_time:${Math.floor((now / 1000 - sinceDays * 86400) / 86400) * 86400}`;
  return { query: q, queryType: latest ? "Latest" : "Top" };
}

export async function searchTwitterApiIo(q: SearchQuery): Promise<SearchHit[]> {
  const { query, queryType } = twapiQuery(q.query, q.sinceDays);
  const hits: SearchHit[] = [];
  let cursor = "";
  for (let page = 0; page < Math.ceil(Math.min(Math.max(q.limit, 1), 60) / 20); page++) {
    const params = new URLSearchParams({ query, queryType, cursor });
    const data = await getJson<{ tweets?: TwapiTweet[]; has_next_page?: boolean; next_cursor?: string }>(`${TWAPI}/twitter/tweet/advanced_search?${params}`, {
      headers: headers(),
      cacheTtlMs: TTL.social,
      signal: q.signal,
    });
    hits.push(...(data.tweets ?? []).map(twapiToHit));
    if (!data.has_next_page || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return hits.slice(0, q.limit);
}

/** Replies to an original post, most liked first among the newest page (one page = 20). */
export async function twapiTopReplies(id: string, max: number): Promise<string[]> {
  const data = await getJson<{ replies?: TwapiTweet[]; tweets?: TwapiTweet[] }>(`${TWAPI}/twitter/tweet/replies?${new URLSearchParams({ tweetId: id })}`, {
    headers: headers(),
    cacheTtlMs: TTL.social,
  });
  // The docs name the list "replies"; the live API (2026-10-11) returns it as "tweets".
  return (data.tweets ?? data.replies ?? [])
    .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
    .slice(0, max)
    .map((r) => `- **@${r.author?.userName ?? "?"}** (♥${r.likeCount ?? 0}): ${oneLine(r.text, 500)}`);
}

let creditsCache: { at: number; text: string } | undefined;

/** Remaining credits for trawl_doctor, cached 10 minutes (the info endpoint is free). */
export async function twapiCredits(): Promise<string> {
  if (creditsCache && Date.now() - creditsCache.at < 600_000) return creditsCache.text;
  try {
    const info = await getJson<{ recharge_credits?: number; total_bonus_credits?: number }>(`${TWAPI}/oapi/my/info`, {
      headers: headers(),
      retries: 0,
      timeoutMs: 8000,
    });
    const text = `créditos: ${info.recharge_credits ?? 0} pagos + ${info.total_bonus_credits ?? 0} de bônus`;
    creditsCache = { at: Date.now(), text };
    return text;
  } catch (err) {
    return `créditos: não foi possível consultar (${errMessage(err)})`;
  }
}
