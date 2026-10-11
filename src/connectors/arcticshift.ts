import { getJson, HttpError, TTL } from "../core/http.ts";
import { log } from "../core/log.ts";
import type { SearchHit } from "../core/types.ts";
import { daysAgoDate, errMessage, isoDate, oneLine, sleep, truncate, ymd } from "../core/util.ts";

// Arctic Shift (github.com/ArthurHeitmann/arctic_shift): open archive of Reddit, successor of
// Pushshift. No key. What it can and cannot do (measured 2026-10-11):
//  - keyword search needs a subreddit or author; a global query returns 400;
//  - keyword search is expensive and has a per-minute budget: one query can take ~10 s and the
//    next ones fail at once with 422 "Timeout. Maybe slow down a bit" until x-ratelimit-reset;
//  - listing a subreddit's recent posts, subreddit discovery and lookups by id are cheap.
// So: ids → scores for Reddit's own search results, listing + local keyword filter as the
// fallback, and keyword search only when the budget allows. No uptime guarantee either.

const API = "https://arctic-shift.photon-reddit.com/api";
const OUTAGE_PAUSE_MS = 10 * 60_000;
let pausedUntil = 0;
let lastError = "";

export function arcticStatus(): { up: boolean; lastError: string } {
  return { up: Date.now() >= pausedUntil, lastError };
}

export function isBudgetError(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 429 || (err.status === 422 && /slow down/i.test(err.message)));
}

async function call<T>(path: string, ttl: number, signal?: AbortSignal): Promise<T> {
  const wait = pausedUntil - Date.now();
  if (wait > 0) throw new Error(`Arctic Shift em pausa por ~${Math.ceil(wait / 1000)} s (${lastError})`);
  try {
    return await getJson<T>(`${API}${path}`, { cacheTtlMs: ttl, timeoutMs: 20_000, retries: 0, signal });
  } catch (err) {
    lastError = errMessage(err);
    if (isBudgetError(err)) {
      // Budget exhausted: pause exactly until the announced reset.
      const secs = (err as HttpError).retryAfterSec ?? 60;
      pausedUntil = Date.now() + secs * 1000;
    } else if (!(err instanceof HttpError) || err.status >= 500) {
      pausedUntil = Date.now() + OUTAGE_PAUSE_MS;
    }
    log.warn(`arctic shift: ${lastError}`);
    throw err;
  }
}

interface ArcticPost {
  id: string;
  title: string;
  selftext?: string;
  score?: number;
  num_comments?: number;
  subreddit: string;
  created_utc: number;
  author?: string;
  permalink?: string;
  url?: string;
}

const POST_FIELDS = "id,title,selftext,score,num_comments,subreddit,created_utc,author,url";

const postUrl = (p: ArcticPost) => (p.permalink ? `https://www.reddit.com${p.permalink}` : `https://www.reddit.com/r/${p.subreddit}/comments/${p.id}/`);

function toHit(p: ArcticPost, extraTag?: string): SearchHit {
  const body = p.selftext && p.selftext !== "[removed]" && p.selftext !== "[deleted]" ? p.selftext : "";
  return {
    url: postUrl(p),
    title: p.title,
    snippet: oneLine(body || (p.url && !p.url.includes(p.id) ? `link: ${p.url}` : "")),
    source: "reddit",
    provider: "arctic-shift",
    published: isoDate(p.created_utc),
    author: p.author,
    metrics: { score: p.score, comments: p.num_comments },
    tags: [`r/${p.subreddit}`, "votos do arquivo (podem estar defasados)", ...(extraTag ? [extraTag] : [])],
  };
}

const engagement = (p: ArcticPost) => (p.score ?? 0) + 2 * (p.num_comments ?? 0);

const STOP = new Set(["the", "and", "for", "with", "com", "para", "que", "dos", "das", "como", "how", "what", "uma", "this", "from"]);

export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [])].filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Posts that contain enough of the terms, best matches first. */
export function filterByTerms(posts: ArcticPost[], terms: string[]): ArcticPost[] {
  if (!terms.length) return posts;
  const need = Math.min(2, terms.length);
  return posts
    .map((p) => {
      const text = `${p.title} ${p.selftext ?? ""}`.toLowerCase();
      return { p, matched: terms.filter((t) => text.includes(t)).length };
    })
    .filter((x) => x.matched >= need)
    .sort((a, b) => b.matched - a.matched || engagement(b.p) - engagement(a.p))
    .map((x) => x.p);
}

/** Votes and comment counts for posts found elsewhere (one cheap request for up to 100 ids). */
export async function arcticScores(ids: string[], signal?: AbortSignal): Promise<Map<string, { score?: number; comments?: number }>> {
  const unique = [...new Set(ids)].slice(0, 100);
  if (!unique.length) return new Map();
  const data = await call<{ data?: ArcticPost[] }>(`/posts/ids?ids=${unique.join(",")}&fields=id,score,num_comments`, TTL.social, signal);
  return new Map((data.data ?? []).map((p) => [p.id, { score: p.score, comments: p.num_comments }]));
}

/**
 * Recent posts of a subreddit filtered locally by the query terms. Pages backwards with
 * `before` until the window start (or maxPages): a busy subreddit holds only ~2 days per page,
 * so the tag states how far back the filter really looked.
 */
async function recentFiltered(
  subreddit: string,
  terms: string[],
  limit: number,
  sinceDays?: number,
  signal?: AbortSignal,
  maxPages = 10,
): Promise<SearchHit[]> {
  const afterEpoch = sinceDays ? Math.floor(daysAgoDate(sinceDays).getTime() / 1000) : undefined;
  const posts: ArcticPost[] = [];
  let before: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ subreddit, limit: "auto", sort: "desc", fields: POST_FIELDS });
    if (sinceDays) params.set("after", ymd(daysAgoDate(sinceDays)));
    if (before) params.set("before", String(before));
    const batch = (await call<{ data?: ArcticPost[] }>(`/posts/search?${params}`, TTL.social, signal)).data ?? [];
    posts.push(...batch);
    const oldest = batch.at(-1)?.created_utc;
    // An empty or short page means the window (or the archive) is exhausted.
    if (!oldest || batch.length < 90 || (afterEpoch && oldest <= afterEpoch) || !sinceDays) break;
    before = oldest;
  }
  const oldest = posts.at(-1)?.created_utc;
  const reachedStart = afterEpoch !== undefined && oldest !== undefined && oldest <= afterEpoch + 86_400;
  const coverage = oldest && !reachedStart ? `filtro local nos posts desde ${new Date(oldest * 1000).toISOString().slice(0, 10)} (cobertura parcial)` : undefined;
  return filterByTerms(posts, terms)
    .slice(0, limit)
    .map((p) => toHit(p, coverage));
}

/** Keyword search inside a subreddit; falls back to listing + local filter when the budget is gone. */
export async function arcticSearchSubreddit(subreddit: string, query: string, limit: number, sinceDays?: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const terms = searchTerms(query);
  if (terms.length) {
    const params = new URLSearchParams({ subreddit, query: query.trim(), limit: String(Math.min(Math.max(limit * 3, 25), 100)), sort: "desc", fields: POST_FIELDS });
    if (sinceDays) params.set("after", ymd(daysAgoDate(sinceDays)));
    try {
      const data = await call<{ data?: ArcticPost[] }>(`/posts/search?${params}`, TTL.social, signal);
      return (data.data ?? [])
        .sort((a, b) => engagement(b) - engagement(a))
        .slice(0, limit)
        .map((p) => toHit(p));
    } catch (err) {
      if (!isBudgetError(err)) throw err;
      // Budget pauses are short; give the listing a moment rather than failing.
      await sleep(Math.min(((err as HttpError).retryAfterSec ?? 5) * 1000, 8000));
      pausedUntil = 0;
    }
  }
  return recentFiltered(subreddit, terms, limit, sinceDays, signal);
}

interface ArcticSubreddit {
  display_name: string;
  subscribers?: number;
  over18?: boolean;
}

const NOISE_SUBS = /meme|hack|cheat|nsfw|porn|circlejerk|shitpost|gonewild/i;

/** Subreddits whose name starts with a query word, biggest first, minus memes, cheats and NSFW. */
export async function arcticDiscoverSubreddits(query: string, perWord = 2, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for (const word of searchTerms(query).slice(0, 3)) {
    const data = await call<{ data?: ArcticSubreddit[] }>(`/subreddits/search?subreddit_prefix=${encodeURIComponent(word)}&limit=15`, TTL.search, signal);
    const picked = (data.data ?? [])
      .filter((s) => !s.over18 && !NOISE_SUBS.test(s.display_name) && (s.subscribers ?? 0) >= 1000)
      .sort((a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0))
      .slice(0, perWord)
      .map((s) => s.display_name);
    for (const name of picked) if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Reddit-wide fallback when Reddit's own search is rate-limited. */
export async function arcticSearchDiscovered(query: string, limit: number, sinceDays?: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const subs = (await arcticDiscoverSubreddits(query, 2, signal)).slice(0, 3);
  const terms = searchTerms(query);
  const hits: SearchHit[] = [];
  for (const sub of subs) {
    try {
      hits.push(...(await recentFiltered(sub, terms, limit, sinceDays, signal, 2)));
    } catch (err) {
      log.warn(`arctic shift r/${sub}: ${errMessage(err)}`);
    }
  }
  return hits
    .sort((a, b) => (b.metrics?.score ?? 0) + 2 * (b.metrics?.comments ?? 0) - ((a.metrics?.score ?? 0) + 2 * (a.metrics?.comments ?? 0)))
    .slice(0, limit)
    .map((h) => ({ ...h, tags: [...(h.tags ?? []), `busca do Reddit indisponível: subreddits ${subs.map((s) => `r/${s}`).join(", ")}`] }));
}

interface ArcticComment {
  id: string;
  author?: string;
  body?: string;
  score?: number;
  created_utc?: number;
  replies?: ArcticNode[] | { data?: { children?: ArcticNode[] } } | "";
}

interface ArcticNode {
  kind: string;
  data: ArcticComment;
}

function childrenOf(replies: ArcticComment["replies"]): ArcticNode[] {
  if (!replies) return [];
  if (Array.isArray(replies)) return replies;
  return replies.data?.children ?? [];
}

function renderTree(nodes: ArcticNode[], depth: number, budget: { left: number }): string[] {
  const out: string[] = [];
  const sorted = [...nodes].filter((n) => n.kind === "t1").sort((a, b) => (b.data.score ?? 0) - (a.data.score ?? 0));
  for (const n of sorted) {
    if (budget.left <= 0) break;
    const c = n.data;
    if (!c.body || c.body === "[removed]" || c.body === "[deleted]" || c.author === "AutoModerator") continue;
    budget.left--;
    out.push(`${"  ".repeat(depth)}- **${c.author ?? "?"}** (▲${c.score ?? 0}): ${truncate(c.body.replace(/\s+/g, " "), 700)}`);
    if (depth < 2) out.push(...renderTree(childrenOf(c.replies), depth + 1, budget));
  }
  return out;
}

export async function arcticPost(id: string): Promise<ArcticPost | undefined> {
  return (await call<{ data?: ArcticPost[] }>(`/posts/ids?ids=${id}`, TTL.social)).data?.[0];
}

export async function arcticThread(id: string, maxComments: number): Promise<{ post: ArcticPost; url: string; commentsMd: string[] }> {
  const posts = await call<{ data: ArcticPost[] }>(`/posts/ids?ids=${id}`, TTL.social);
  const tree = await call<{ data: ArcticNode[] }>(`/comments/tree?link_id=t3_${id}&limit=${Math.max(maxComments * 3, 100)}`, TTL.social);
  const post = posts.data?.[0];
  if (!post) throw new Error(`post ${id} não está no Arctic Shift`);
  return { post, url: postUrl(post), commentsMd: renderTree(tree.data ?? [], 0, { left: maxComments }) };
}
