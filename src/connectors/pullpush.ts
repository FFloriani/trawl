import { getJson, TTL } from "../core/http.ts";
import type { Connector, SearchHit, SearchQuery } from "../core/types.ts";
import { isoDate, oneLine } from "../core/util.ts";

// PullPush (pullpush.io): Pushshift-style archive of Reddit with keyword search across ALL of
// Reddit, including comment bodies, no key. Scores are snapshots from ingestion (often 1), so
// it is a discovery source: what people wrote, where and when, not how much it was liked.

const API = "https://api.pullpush.io/reddit/search";

interface PullPushComment {
  id: string;
  body?: string;
  author?: string;
  subreddit?: string;
  score?: number;
  created_utc?: number;
  permalink?: string;
  link_id?: string;
}

export function commentToHit(c: PullPushComment): SearchHit | undefined {
  const body = (c.body ?? "").trim();
  if (!body || body === "[removed]" || body === "[deleted]" || c.author === "AutoModerator") return undefined;
  const url = c.permalink
    ? `https://www.reddit.com${c.permalink}`
    : c.link_id && c.subreddit
      ? `https://www.reddit.com/r/${c.subreddit}/comments/${c.link_id.replace(/^t3_/, "")}/comment/${c.id}/`
      : undefined;
  if (!url) return undefined;
  return {
    url,
    title: oneLine(body, 140),
    snippet: oneLine(body, 500),
    source: "reddit_comments",
    provider: "pullpush",
    published: isoDate(c.created_utc),
    author: c.author,
    tags: [c.subreddit ? `r/${c.subreddit}` : "", "comentário", "votos do arquivo não medem curtidas"].filter(Boolean),
  };
}

export const redditComments: Connector = {
  name: "reddit_comments",
  label: "Reddit (comentários, via PullPush)",
  async availability() {
    return { ok: true, mode: "busca em comentários do Reddit inteiro pelo arquivo PullPush, sem chave" };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const params = new URLSearchParams({ q: q.query, size: String(Math.min(q.limit * 2, 100)) });
    if (q.sinceDays) params.set("after", String(Math.floor(Date.now() / 1000 - q.sinceDays * 86400)));
    const data = await getJson<{ data?: PullPushComment[] }>(`${API}/comment/?${params}`, { cacheTtlMs: TTL.social, timeoutMs: 25_000, signal: q.signal });
    return (data.data ?? [])
      .map(commentToHit)
      .filter((h): h is SearchHit => Boolean(h))
      .slice(0, q.limit);
  },
};

interface PullPushPost {
  id: string;
  title: string;
  selftext?: string;
  subreddit: string;
  author?: string;
  created_utc: number;
  permalink?: string;
}

/** Posts matching the words anywhere on Reddit (archive): used when Reddit's own search fails. */
export async function pullpushPosts(query: string, limit: number, sinceDays?: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, size: String(Math.min(limit, 100)) });
  if (sinceDays) params.set("after", String(Math.floor(Date.now() / 1000 - sinceDays * 86400)));
  const data = await getJson<{ data?: PullPushPost[] }>(`${API}/submission/?${params}`, { cacheTtlMs: TTL.social, timeoutMs: 25_000, signal });
  return (data.data ?? []).map((p) => ({
    url: p.permalink ? `https://www.reddit.com${p.permalink}` : `https://www.reddit.com/r/${p.subreddit}/comments/${p.id}/`,
    title: p.title,
    snippet: oneLine(p.selftext && p.selftext !== "[removed]" ? p.selftext : ""),
    source: "reddit" as const,
    provider: "pullpush",
    published: isoDate(p.created_utc),
    author: p.author,
    tags: [`r/${p.subreddit}`, "via arquivo PullPush"],
  }));
}
