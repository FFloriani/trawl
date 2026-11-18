import { XMLParser } from "fast-xml-parser";
import { config } from "../config.ts";
import { getJson, HttpError, request, TTL } from "../core/http.ts";
import type { Availability, Connector, ReadResult, SearchHit, SearchQuery } from "../core/types.ts";
import { errMessage, isoDate, oneLine, stripTags, truncate } from "../core/util.ts";
import { arcticPost, arcticScores, arcticSearchDiscovered, arcticSearchSubreddit, arcticStatus, arcticThread } from "./arcticshift.ts";
import { pullpushPosts } from "./pullpush.ts";
import { BLOCK_NOTE, hasSession, rejectSession, sessionCookie, sessionRejected } from "./reddit-session.ts";
import { commentsMarkdown, shredditComments, shredditSearch, shredditSubredditFeed } from "./shreddit.ts";

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

// With the user's own session cookie (REDDIT_COOKIE), the JSON of a thread answers as that user,
// with the original text (the site pages may show Reddit's machine translation). The JSON
// *search* answers 403 to many addresses even with the session (measured 2026-11-08), so after
// one such answer it is skipped for the rest of the process and the site search does the work.
const hasJsonApi = () => hasOAuth() || hasSession();
let jsonSearchBlocked = false;

/** Reddit's JSON API: the approved OAuth app when configured, else the logged-in session. */
async function apiGet<T>(path: string, ttl: number, signal?: AbortSignal): Promise<T> {
  if (hasOAuth()) return oauthGet<T>(path, ttl, signal);
  const [p, qs] = path.split("?");
  const cookie = sessionCookie();
  try {
    return await getJson<T>(`https://www.reddit.com${p}.json${qs ? `?${qs}` : ""}`, {
      browser: true,
      headers: cookie ? { cookie } : {},
      cacheTtlMs: ttl,
      maxRetryWaitMs: 10_000,
      signal,
    });
  } catch (err) {
    // 401 = the session is gone. 403 = this address (or a private place) is blocked: the session is fine.
    if (err instanceof HttpError && err.status === 401) rejectSession();
    if (err instanceof HttpError && err.status === 403 && /\/search$/.test(p ?? "")) {
      jsonSearchBlocked = true;
      throw new Error(`a busca pela API do Reddit está bloqueada neste endereço (403); ${hasSession() ? "a busca do site, com a sessão, segue funcionando" : BLOCK_NOTE}`);
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
    const arctic = arcticStatus();
    const archive = arctic.up ? "" : ` (Arctic Shift em pausa agora: ${arctic.lastError})`;
    if (hasSession()) {
      return {
        ok: true,
        mode: `sessão logada (REDDIT_COOKIE): busca do próprio site do Reddit com votos atuais e leitura das conversas pelo JSON, no texto original; reserva em RSS e Arctic Shift${archive}`,
        note: "subreddit:Nome restringe a um subreddit. A fonte reddit_comments busca dentro de comentários do Reddit inteiro.",
      };
    }
    return {
      ok: true,
      mode: `sem sessão: busca do site do Reddit quando ele deixa, com reserva em RSS (cerca de 1 pedido a cada 30 s) e Arctic Shift${archive}`,
      note: `${sessionRejected() ? `${sessionRejected()}. ` : ""}Desde nov/2026 o Reddit responde 403 ("blocked by network security") a muitos endereços sem sessão: aí só sobram o RSS e o arquivo. subreddit:Nome restringe a um subreddit.`,
      enable:
        "Com a sua sessão do Reddit (REDDIT_COOKIE no .env da pasta de dados, trawl_doctor mostra onde) a busca do site e a leitura das conversas voltam. Apps OAuth novos dependem de aprovação do Reddit (Responsible Builder Policy); com um app aprovado, use REDDIT_CLIENT_ID e REDDIT_CLIENT_SECRET.",
    };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const limit = Math.min(q.limit, 50);
    const { subreddit, rest } = splitSubreddit(q.query);
    if (hasOAuth()) return apiSearch(q, limit, subreddit, rest);
    if (!hasSession()) return keylessSearch(q, limit, subreddit, rest);
    // Logged-in session: the site's search, plus the JSON search while this address is not blocked
    // (they rank differently: measured 2026-10-11, each found relevant posts the other missed).
    const [site, api] = await Promise.allSettled([
      shredditSearch(subreddit ? rest || subreddit : q.query, { subreddit, sinceDays: q.sinceDays, limit, signal: q.signal }),
      jsonSearchBlocked ? Promise.resolve([] as SearchHit[]) : apiSearch(q, limit, subreddit, rest),
    ]);
    const lists = [site, api].filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<SearchHit[]>).value);
    const merged = dedupeCrossposts(interleaveUnique(lists)).slice(0, limit);
    if (merged.length) return merged;
    // Nothing from the session paths: the keyless chain, without asking the site search a second time.
    const why = site.status === "rejected" ? [`site: ${errMessage(site.reason)}`] : [];
    return keylessSearch(q, limit, subreddit, rest, why);
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

/**
 * One comment in its original language, through the JSON of its thread (the site search shows
 * Reddit's machine translation to the account's language). Needs the session or OAuth.
 */
export async function originalComment(
  postId: string,
  commentId: string,
  signal?: AbortSignal,
): Promise<{ body: string; author?: string; score?: number; created?: number } | undefined> {
  if (!hasJsonApi()) return undefined;
  const data = await apiGet<[unknown, { data?: { children?: Array<{ kind: string; data: RedditComment }> } }]>(
    `/comments/${postId}/_/${commentId}?context=0&limit=1&depth=1&raw_json=1`,
    TTL.social,
    signal,
  );
  const c = data[1]?.data?.children?.find((x) => x.kind === "t1")?.data;
  return c?.body ? { body: c.body, author: c.author, score: c.score, created: c.created_utc } : undefined;
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
async function keylessSearch(q: SearchQuery, limit: number, subreddit: string | undefined, rest: string, triedSite: string[] = []): Promise<SearchHit[]> {
  const errors: string[] = [...triedSite];
  if (!triedSite.length) {
    try {
      const hits = await shredditSearch(subreddit ? rest || subreddit : q.query, { subreddit, sinceDays: q.sinceDays, limit, signal: q.signal });
      if (hits.length) return dedupeCrossposts(hits);
    } catch (err) {
      errors.push(`site: ${errMessage(err)}`);
    }
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
    const hits = await rssSearch(q, limit, undefined, rest);
    if (hits.length) return await addArcticScores(hits, q.signal);
    errors.push("rss: nenhum post");
  } catch (err) {
    errors.push(`rss: ${errMessage(err)}`);
  }
  try {
    const hits = await pullpushPosts(q.query, limit, q.sinceDays, q.signal);
    if (hits.length) return addArcticScores(hits, q.signal);
  } catch (err) {
    errors.push(`pullpush: ${errMessage(err)}`);
  }
  if (arcticStatus().up) {
    try {
      const hits = await arcticSearchDiscovered(q.query, limit, q.sinceDays, q.signal);
      if (hits.length) return hits;
      errors.push("arctic: nenhum post nos subreddits do tema");
    } catch (err) {
      errors.push(`arctic: ${errMessage(err)}`);
    }
  }
  // Every path failed or came back empty: say why, instead of a silent "0 results".
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

export type FeedSort = "new" | "hot" | "top";

const TOP_WINDOW: Record<string, number | undefined> = { hour: 1, day: 1, week: 7, month: 31, year: 365, all: undefined };

/**
 * A subreddit's front page or feed: reddit.com/r/Name, /r/Name/new, /r/Name/top?t=week, and the
 * same paths with .json or .rss. Anything else under /r/Name (wiki, about, a post) is not a feed.
 */
export function subredditTarget(url: string): { subreddit: string; sort: FeedSort; sinceDays?: number } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.hostname.replace(/^(www|old|new|np|m)\./, "") !== "reddit.com") return undefined;
  const path = u.pathname.replace(/\.(json|rss)$/i, "");
  const m = /^\/r\/([A-Za-z0-9_]{2,21})(?:\/(hot|new|top|rising|best|controversial))?\/?$/i.exec(path);
  if (!m) return undefined;
  const kind = (m[2] ?? "hot").toLowerCase();
  const sort: FeedSort = kind === "new" ? "new" : kind === "top" ? "top" : "hot";
  const t = (u.searchParams.get("t") ?? "day").toLowerCase();
  return { subreddit: m[1]!, sort, sinceDays: sort === "top" ? (t in TOP_WINDOW ? TOP_WINDOW[t] : 1) : undefined };
}

const FEED_LABEL: Record<FeedSort, string> = { new: "posts mais novos", hot: "posts em alta", top: "posts mais votados" };

/** The posts of a subreddit feed as a Markdown list (titles in the original language). */
export async function readSubreddit(url: string, limit = 25): Promise<ReadResult> {
  const target = subredditTarget(url);
  if (!target) throw new Error("não é a página de um subreddit (reddit.com/r/Nome ou /r/Nome/new)");
  const { subreddit, sort, sinceDays } = target;
  const errors: string[] = [];
  let rows: Array<{ title: string; url: string; created?: string; score?: number; comments?: number; author?: string }> = [];
  let via = "";

  try {
    // A crosspost also brings its original from the other subreddit: keep only this one's posts.
    const own = new RegExp(`/r/${subreddit}/`, "i");
    rows = (await shredditSubredditFeed(subreddit, sort, { sinceDays, limit: limit + 5 })).filter((p) => own.test(p.url)).slice(0, limit);
    via =hasSession() ? "site do Reddit, com a sua sessão" : "site do Reddit";
  } catch (err) {
    errors.push(`site: ${errMessage(err)}`);
  }
  if (!rows.length && arcticStatus().up) {
    try {
      const hits = await arcticSearchSubreddit(subreddit, "", limit, sinceDays);
      rows = hits.map((h) => ({ title: h.title, url: h.url, created: h.published, score: h.metrics?.score, comments: h.metrics?.comments, author: h.author }));
      via = "arquivo Arctic Shift (pode atrasar algumas horas; votos do arquivo, não os atuais)";
    } catch (err) {
      errors.push(`arctic: ${errMessage(err)}`);
    }
  }
  if (!rows.length) {
    throw new Error(errors.length ? `não consegui listar r/${subreddit}: ${errors.join(" | ")}` : `r/${subreddit} não tem posts nesse filtro`);
  }
  if (sort === "new") rows.sort((a, b) => (isoDate(b.created) ?? "").localeCompare(isoDate(a.created) ?? ""));

  return {
    url: `https://www.reddit.com/r/${subreddit}/${sort === "hot" ? "" : `${sort}/`}`,
    title: `r/${subreddit} · ${FEED_LABEL[sort]}`,
    source: "reddit",
    note: `Lista de posts lida pelo ${via}. Para ler um post com os comentários, chame trawl_read com o link dele.`,
    content: rows
      .map((r) => {
        const meta = [
          r.created ? `${isoDate(r.created)?.slice(0, 16).replace("T", " ")} UTC` : "",
          r.score !== undefined ? `▲${r.score}` : "",
          r.comments !== undefined ? `${r.comments} coment.` : "",
          r.author ? `u/${r.author}` : "",
        ].filter(Boolean);
        return `- [${r.title.replace(/[[\]]/g, "")}](${r.url})${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
      })
      .join("\n"),
  };
}

/** A share link (reddit.com/r/Name/s/Code) opens the post after a redirect: follow it once. */
export async function resolveRedditShare(url: string): Promise<string> {
  const cookie = sessionCookie();
  const res = await request(url, { browser: true, headers: cookie ? { cookie } : {} });
  if (!redditThreadId(res.url)) throw new Error("o link de compartilhamento do Reddit não levou a um post");
  return res.url;
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
