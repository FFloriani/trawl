import { XMLParser } from "fast-xml-parser";
import { config } from "../config.ts";
import { getJson, HttpError, request, TTL } from "../core/http.ts";
import type { Availability, Connector, ReadResult, SearchHit, SearchQuery } from "../core/types.ts";
import { errMessage, isoDate, oneLine, stripTags, truncate } from "../core/util.ts";
import { arcticPost, arcticScores, arcticSearchDiscovered, arcticSearchSubreddit, arcticStatus, arcticThread } from "./arcticshift.ts";
import { pullpushPosts } from "./pullpush.ts";
import { commentsMarkdown, shredditComments, shredditSearch } from "./shreddit.ts";

// Three backends. With a free "script" app (REDDIT_CLIENT_ID/SECRET) we use the OAuth API:
// ~100 req/min, scores and nested comments. Without it, Arctic Shift (keyless archive with
// scores) handles subreddit-scoped searches and comment trees, and the public Atom feeds handle
// global search: no key, but roughly one request per 30-60 s per IP and no scores.

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "entry",
});

interface AtomEntry {
  id?: string;
  title?: string;
  author?: { name?: string };
  category?: { "@_term"?: string } | Array<{ "@_term"?: string }>;
  content?: string | { "#text"?: string };
  link?: { "@_href"?: string } | Array<{ "@_href"?: string }>;
  updated?: string;
  published?: string;
}

function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function entryText(e: AtomEntry): string {
  const raw = typeof e.content === "string" ? e.content : (e.content?.["#text"] ?? "");
  return stripTags(raw).replace(/\s*submitted by\s+\/u\/\S+.*$/i, "").replace(/\[link\]\s*\[comments\]\s*$/i, "").trim();
}

export function parseAtom(text: string): AtomEntry[] {
  const doc = xml.parse(text) as { feed?: { entry?: AtomEntry[] } };
  return doc.feed?.entry ?? [];
}

function timeParam(sinceDays?: number): string {
  if (!sinceDays) return "all";
  if (sinceDays <= 1) return "day";
  if (sinceDays <= 7) return "week";
  if (sinceDays <= 31) return "month";
  if (sinceDays <= 365) return "year";
  return "all";
}

// ---------- OAuth backend ----------

let token: { value: string; expires: number } | undefined;

async function oauthToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const { redditClientId: id, redditClientSecret: secret } = config.keys;
  const res = await request("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    body: "grant_type=client_credentials",
    headers: {
      authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    retries: 1,
  });
  const data = JSON.parse(res.text) as { access_token?: string; expires_in?: number; error?: string };
  if (!data.access_token) throw new Error(`Reddit OAuth recusou as credenciais: ${data.error ?? "sem token"}`);
  token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return token.value;
}

const hasOAuth = () => Boolean(config.keys.redditClientId && config.keys.redditClientSecret);

interface RedditPost {
  id: string;
  title: string;
  permalink: string;
  url?: string;
  score: number;
  num_comments: number;
  subreddit: string;
  created_utc: number;
  selftext?: string;
  author?: string;
  over_18?: boolean;
}

interface RedditComment {
  author?: string;
  body?: string;
  score?: number;
  created_utc?: number;
  replies?: { data?: { children?: Array<{ kind: string; data: RedditComment }> } } | "";
}

async function oauthGet<T>(path: string, ttl: number, signal?: AbortSignal): Promise<T> {
  return getJson<T>(`https://oauth.reddit.com${path}`, {
    headers: { authorization: `Bearer ${await oauthToken()}` },
    cacheTtlMs: ttl,
    signal,
  });
}

// ---------- logged-in session (opt-in) ----------

// With the user's own session cookie (REDDIT_COOKIE), www.reddit.com/*.json answers as that user:
// 100 posts per call, full post text, the post's vote and nested comments. The cookie never
// leaves this machine except to reddit.com, and a rejected cookie switches back to keyless mode.
let cookieRejected = "";

function cookieHeader(): string {
  const v = config.keys.redditCookie ?? "";
  return v.includes("=") ? v : `reddit_session=${v}`;
}

const hasCookie = () => Boolean(config.keys.redditCookie) && !cookieRejected;
const hasJsonApi = () => hasOAuth() || hasCookie();

/** Reddit's JSON API: the approved OAuth app when configured, else the logged-in session. */
async function apiGet<T>(path: string, ttl: number, signal?: AbortSignal): Promise<T> {
  if (hasOAuth()) return oauthGet<T>(path, ttl, signal);
  const [p, qs] = path.split("?");
  try {
    return await getJson<T>(`https://www.reddit.com${p}.json${qs ? `?${qs}` : ""}`, {
      browser: true,
      headers: { cookie: cookieHeader() },
      cacheTtlMs: ttl,
      maxRetryWaitMs: 10_000,
      signal,
    });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      cookieRejected = "o Reddit recusou o cookie da sessão (expirado ou inválido); atualize REDDIT_COOKIE no .env da pasta de dados (trawl_doctor mostra onde)";
    }
    throw err;
  }
}

const apiProvider = () => (hasOAuth() ? "reddit-oauth" : "reddit-sessao");

// ---------- connector ----------

export const reddit: Connector = {
  name: "reddit",
  label: "Reddit",
  async availability(): Promise<Availability> {
    if (hasOAuth()) return { ok: true, mode: "API OAuth (credenciais aprovadas, ~100 req/min)" };
    if (hasCookie()) return { ok: true, mode: "sessão logada (REDDIT_COOKIE): JSON do Reddit com dados completos; sem chave como reserva" };
    const arctic = arcticStatus();
    return {
      ok: true,
      mode: `busca do próprio site do Reddit (votos e comentários atuais), com reserva em RSS, PullPush e Arctic Shift; comentários das threads com votos reais${arctic.up ? "" : ` (Arctic Shift em pausa agora: ${arctic.lastError})`}`,
      note: `${cookieRejected ? `${cookieRejected}. ` : ""}subreddit:Nome restringe a um subreddit. A fonte reddit_comments busca dentro de comentários do Reddit inteiro.`,
      enable:
        "Opcional: desde nov/2025 o Reddit só libera apps OAuth novos por aprovação (Responsible Builder Policy). Se você já tem um app aprovado, ponha REDDIT_CLIENT_ID e REDDIT_CLIENT_SECRET no .env da pasta de dados (trawl_doctor mostra onde)",
    };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const limit = Math.min(q.limit, 50);
    const { subreddit, rest } = splitSubreddit(q.query);
    if (!hasJsonApi()) return keylessSearch(q, limit, subreddit, rest);
    if (hasOAuth()) return apiSearch(q, limit, subreddit, rest);
    // Logged-in session: the site's search and the JSON search rank differently (measured
    // 2026-10-11: each found relevant posts the other missed), so run both and interleave.
    const [site, api] = await Promise.allSettled([
      shredditSearch(subreddit ? rest || subreddit : q.query, { subreddit, sinceDays: q.sinceDays, limit, signal: q.signal }),
      apiSearch(q, limit, subreddit, rest),
    ]);
    const lists = [site, api].filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<SearchHit[]>).value);
    const merged = dedupeCrossposts(interleaveUnique(lists)).slice(0, limit);
    // A rejected cookie or a blocked site search ends up here with too little: use the keyless chain.
    return merged.length ? merged : keylessSearch(q, limit, subreddit, rest);
  },
};

async function apiSearch(q: SearchQuery, limit: number, subreddit: string | undefined, rest: string): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: subreddit ? rest || subreddit : q.query, sort: "relevance", t: timeParam(q.sinceDays), limit: String(limit), type: "link", raw_json: "1" });
  if (subreddit) params.set("restrict_sr", "1");
  const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search` : "/search";
  const data = await apiGet<{ data: { children: Array<{ data: RedditPost }> } }>(`${path}?${params}`, TTL.social, q.signal);
  return data.data.children.map(({ data: p }) => ({
    url: `https://www.reddit.com${p.permalink}`,
    title: p.title,
    snippet: oneLine(p.selftext || (p.url && !p.url.includes(p.permalink) ? `link: ${p.url}` : "")),
    source: "reddit" as const,
    provider: apiProvider(),
    published: isoDate(p.created_utc),
    author: p.author,
    metrics: { score: p.score, comments: p.num_comments },
    tags: [`r/${p.subreddit}`, ...(p.over_18 ? ["NSFW"] : [])],
  }));
}

/** Round-robin over ranked lists, keeping the first copy of each thread (fuller record wins ties). */
export function interleaveUnique(lists: SearchHit[][]): SearchHit[] {
  const out = new Map<string, SearchHit>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const hit = list[i];
      if (!hit) continue;
      const key = redditThreadId(hit.url) ?? hit.url;
      const prev = out.get(key);
      if (!prev) out.set(key, hit);
      else if (!prev.author && hit.author) out.set(key, { ...hit, metrics: prev.metrics ?? hit.metrics });
    }
  }
  return [...out.values()];
}

/**
 * Keyless chain, best data first:
 *  1. Reddit's own search fragment (live votes and comment counts);
 *  2. subreddit: Arctic Shift keyword search / paged listing · global: RSS + Arctic votes;
 *  3. global: PullPush archive keyword search + Arctic votes;
 *  4. global: Arctic Shift over the topic's subreddits.
 */
async function keylessSearch(q: SearchQuery, limit: number, subreddit: string | undefined, rest: string): Promise<SearchHit[]> {
  const errors: string[] = [];
  try {
    const hits = await shredditSearch(subreddit ? rest || subreddit : q.query, { subreddit, sinceDays: q.sinceDays, limit, signal: q.signal });
    if (hits.length) return dedupeCrossposts(hits);
  } catch (err) {
    errors.push(`site: ${errMessage(err)}`);
  }
  if (subreddit) {
    if (arcticStatus().up) {
      try {
        return await arcticSearchSubreddit(subreddit, rest, limit, q.sinceDays, q.signal);
      } catch (err) {
        errors.push(`arctic: ${errMessage(err)}`);
      }
    }
    return rssSearch(q, limit, subreddit, rest);
  }
  try {
    return await addArcticScores(await rssSearch(q, limit, undefined, rest), q.signal);
  } catch (err) {
    errors.push(`rss: ${errMessage(err)}`);
  }
  try {
    const hits = await pullpushPosts(q.query, limit, q.sinceDays, q.signal);
    if (hits.length) return addArcticScores(hits, q.signal);
  } catch (err) {
    errors.push(`pullpush: ${errMessage(err)}`);
  }
  if (arcticStatus().up) return arcticSearchDiscovered(q.query, limit, q.sinceDays, q.signal);
  throw new Error(errors.join(" | "));
}

async function rssSearch(q: SearchQuery, limit: number, subreddit: string | undefined, rest: string): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: subreddit ? rest || subreddit : q.query, sort: "relevance", t: timeParam(q.sinceDays), limit: String(limit) });
  if (subreddit) params.set("restrict_sr", "1");
  const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search.rss` : "/search.rss";
  const res = await request(`https://www.reddit.com${path}?${params}`, {
    browser: true,
    cacheTtlMs: TTL.social,
    maxRetryWaitMs: 35_000,
    signal: q.signal,
  });
  return dedupeCrossposts(
    parseAtom(res.text)
      .filter((e) => e.id?.startsWith("t3_"))
      .map((e) => {
        const sub = first(e.category)?.["@_term"];
        return {
          url: first(e.link)?.["@_href"] ?? "",
          title: e.title ?? "(sem título)",
          snippet: oneLine(entryText(e)),
          source: "reddit" as const,
          provider: "reddit-rss",
          published: isoDate(e.published ?? e.updated),
          author: e.author?.name?.replace(/^\/u\//, ""),
          tags: sub ? [`r/${sub}`] : [],
        };
      })
      .filter((h) => h.url),
  );
}

/** The feeds carry no votes; one cheap Arctic Shift lookup by id fills them in. */
async function addArcticScores(hits: SearchHit[], signal?: AbortSignal): Promise<SearchHit[]> {
  if (!hits.length || !arcticStatus().up) return hits;
  try {
    const ids = hits.map((h) => redditThreadId(h.url)).filter((id): id is string => Boolean(id));
    const scores = await arcticScores(ids, signal);
    return hits.map((h) => {
      const s = scores.get(redditThreadId(h.url) ?? "");
      if (!s) return h;
      return { ...h, metrics: { score: s.score, comments: s.comments }, tags: [...(h.tags ?? []), "votos via Arctic Shift"] };
    });
  } catch {
    return hits;
  }
}

/** The same post shared to several subreddits shows up once, tagged with the others. */
export function dedupeCrossposts(hits: SearchHit[]): SearchHit[] {
  const byKey = new Map<string, SearchHit>();
  for (const h of hits) {
    const key = `${(h.author ?? "").toLowerCase()}|${h.title.toLowerCase().replace(/\W+/g, " ").trim()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...h, tags: [...(h.tags ?? [])] });
      continue;
    }
    const sub = h.tags?.find((t) => t.startsWith("r/"));
    if (sub) prev.tags = [...(prev.tags ?? []), `também em ${sub}`];
  }
  return [...byKey.values()];
}

/** "subreddit:Foo bar baz" or "r/Foo bar baz" → { subreddit: "Foo", rest: "bar baz" }. */
export function splitSubreddit(query: string): { subreddit?: string; rest: string } {
  const m = /(?:^|\s)(?:subreddit:|r\/)([A-Za-z0-9_]{2,21})(?=\s|$)/.exec(query);
  if (!m) return { rest: query.trim() };
  return { subreddit: m[1], rest: query.replace(m[0], " ").replace(/\s+/g, " ").trim() };
}

export function redditThreadId(url: string): string | undefined {
  return /\/comments\/([a-z0-9]+)/i.exec(url)?.[1];
}

function renderOauthComments(
  children: Array<{ kind: string; data: RedditComment }> | undefined,
  depth: number,
  budget: { left: number },
): string[] {
  const out: string[] = [];
  for (const c of children ?? []) {
    if (c.kind !== "t1" || budget.left <= 0) continue;
    const d = c.data;
    if (!d.body || d.author === "AutoModerator") continue;
    budget.left--;
    out.push(`${"  ".repeat(depth)}- **${d.author ?? "?"}** (▲${d.score ?? 0}): ${truncate(d.body.replace(/\s+/g, " "), 700)}`);
    if (depth < 2 && d.replies && typeof d.replies === "object") {
      out.push(...renderOauthComments(d.replies.data?.children, depth + 1, budget));
    }
  }
  return out;
}

export async function readRedditThread(url: string, maxComments = 40): Promise<ReadResult> {
  const id = redditThreadId(url);
  if (!id) throw new Error("URL do Reddit sem /comments/<id>");

  if (hasJsonApi()) {
    let listing: [{ data: { children: Array<{ data: RedditPost }> } }, { data: { children: Array<{ kind: string; data: RedditComment }> } }] | undefined;
    try {
      listing = await apiGet<typeof listing & object>(`/comments/${id}?sort=top&limit=${maxComments}&depth=3&raw_json=1`, TTL.social);
    } catch (err) {
      if (hasOAuth()) throw err;
    }
    const p = listing?.[0].data.children[0]?.data;
    const comments = listing?.[1];
    if (listing && !p) throw new Error(`thread ${id} não encontrada`);
    // Reddit resolves /comments/<id> regardless of the subreddit in the URL; a mismatch means a wrong id.
    const wantedSub = /\/r\/([A-Za-z0-9_]+)\//.exec(url)?.[1];
    if (p && wantedSub && p.subreddit.toLowerCase() !== wantedSub.toLowerCase()) {
      throw new Error(`o id ${id} é de um post de r/${p.subreddit}, não de r/${wantedSub}: confira a URL`);
    }
    if (p && comments) return {
      url: `https://www.reddit.com${p.permalink}`,
      title: p.title,
      source: "reddit",
      published: isoDate(p.created_utc),
      author: p.author,
      metrics: { score: p.score, comments: p.num_comments },
      content: [
        `r/${p.subreddit} · ▲${p.score} · ${p.num_comments} comentários`,
        p.url && !p.url.includes(p.permalink) ? `Link: ${p.url}` : "",
        "",
        truncate(p.selftext ?? "", 5000),
        "",
        "## Comentários (mais votados)",
        ...renderOauthComments(comments.data.children, 0, { left: maxComments }),
      ]
        .filter((l, i) => l !== "" || i > 1)
        .join("\n"),
    };
  }

  // Keyless first choice: comments with live votes from the site fragment, post text from Arctic Shift.
  const urlSub = /\/r\/([A-Za-z0-9_]+)\//.exec(url)?.[1];
  if (urlSub) {
    const sub = urlSub;
    try {
      const { comments, total } = await shredditComments(sub, id);
      if (comments.length) {
        const post = arcticStatus().up ? await arcticPost(id).catch(() => undefined) : undefined;
        const slugTitle = /\/comments\/[a-z0-9]+\/([^/?#]+)/i.exec(url)?.[1]?.replace(/_/g, " ");
        return {
          url: `https://www.reddit.com/r/${sub}/comments/${id}/`,
          title: post?.title ?? slugTitle ?? `Reddit ${id}`,
          source: "reddit",
          published: isoDate(post?.created_utc),
          author: post?.author,
          metrics: { score: post?.score, comments: total ?? post?.num_comments },
          note: post ? "Votos dos comentários são atuais; o voto do post vem do arquivo Arctic Shift e pode estar defasado." : undefined,
          content: [
            `r/${sub} · ${total ?? "?"} comentários`,
            post?.url && !post.url.includes(id) ? `Link: ${post.url}` : "",
            "",
            truncate(post?.selftext && post.selftext !== "[removed]" ? post.selftext : "", 5000),
            "",
            "## Comentários (mais votados, votos atuais)",
            ...commentsMarkdown(comments, maxComments),
          ].join("\n"),
        };
      }
    } catch {
      // fall through to the archive and the feed
    }
  }

  if (arcticStatus().up) {
    try {
      const t = await arcticThread(id, maxComments);
      const p = t.post;
      return {
        url: t.url,
        title: p.title,
        source: "reddit",
        published: isoDate(p.created_utc),
        author: p.author,
        metrics: { score: p.score, comments: p.num_comments },
        note: "Via Arctic Shift (arquivo): votos do momento do arquivamento, podem estar defasados.",
        content: [
          `r/${p.subreddit} · ▲${p.score ?? "?"} · ${p.num_comments ?? "?"} comentários`,
          p.url && !p.url.includes(p.id) ? `Link: ${p.url}` : "",
          "",
          truncate(p.selftext ?? "", 5000),
          "",
          "## Comentários (mais votados)",
          ...t.commentsMd,
        ].join("\n"),
      };
    } catch {
      // fall through to the feed
    }
  }

  const res = await request(`https://www.reddit.com/comments/${id}/.rss?sort=top&limit=${maxComments}`, {
    browser: true,
    cacheTtlMs: TTL.social,
    maxRetryWaitMs: 35_000,
  });
  const entries = parseAtom(res.text);
  const post = entries.find((e) => e.id?.startsWith("t3_")) ?? entries[0];
  const comments = entries.filter((e) => e.id?.startsWith("t1_") && e.author?.name !== "/u/AutoModerator");
  const sub = first(post?.category)?.["@_term"];
  return {
    url: first(post?.link)?.["@_href"] ?? url,
    title: post?.title ?? `Reddit ${id}`,
    source: "reddit",
    published: isoDate(post?.published ?? post?.updated),
    author: post?.author?.name?.replace(/^\/u\//, ""),
    note: "Modo RSS: sem scores e só comentários de primeiro nível. Configure o app OAuth do Reddit para dados completos.",
    content: [
      sub ? `r/${sub}` : "",
      "",
      post ? truncate(entryText(post), 5000) : "",
      "",
      "## Comentários (ordenados por votos pelo Reddit)",
      ...comments.map((c) => `- **${c.author?.name?.replace(/^\/u\//, "") ?? "?"}**: ${truncate(entryText(c), 700)}`),
    ].join("\n"),
  };
}
