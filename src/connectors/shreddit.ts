import { request, TTL, type HttpResponse } from "../core/http.ts";
import type { SearchHit } from "../core/types.ts";
import { decodeEntities, isoDate, oneLine, stripTags } from "../core/util.ts";
import { BLOCK_NOTE, sessionCookie } from "./reddit-session.ts";

// Reddit's own web fragments ("shreddit", the HTML the reddit.com UI loads under /svc/shreddit/).
// They answer without a key and server-render live vote and comment counts, which neither the
// RSS feeds nor the archives give. Method learned from mvanhorn/last30days-skill (MIT): about
// one request per second avoids 429s. If Reddit serves its JS challenge page we treat it as a
// failure and fall back; we never try to solve it.

const BASE = "https://www.reddit.com";

export interface ShredditPost {
  id: string;
  title: string;
  url: string;
  subreddit: string;
  score?: number;
  comments?: number;
  created?: string;
  author?: string;
}

export interface ShredditComment {
  id: string;
  author?: string;
  score?: number;
  created?: string;
  depth: number;
  text: string;
}

/** Start tags of a custom element, scanned so that ">" inside quoted attribute values is safe. */
export function findStartTags(html: string, name: string): Array<{ tag: string; index: number }> {
  const out: Array<{ tag: string; index: number }> = [];
  const open = `<${name}`;
  let from = 0;
  for (;;) {
    const i = html.indexOf(open, from);
    if (i < 0) break;
    const next = html[i + open.length];
    if (next !== " " && next !== ">" && next !== "\n" && next !== "\t") {
      from = i + open.length; // a longer element name, e.g. shreddit-comments-page-ad
      continue;
    }
    let quote: string | null = null;
    let j = i + open.length;
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    out.push({ tag: html.slice(i, j + 1), index: i });
    from = j + 1;
  }
  return out;
}

export function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeEntities(m[1]!) : undefined;
}

const num = (v: string | undefined) => (v !== undefined && /^-?\d+$/.test(v) ? Number(v) : undefined);

function assertNotChallenge(html: string): void {
  if (html.includes("/svc/shreddit/js-challenge")) throw new Error("o Reddit pediu verificação anti-robô (js-challenge); usando outro caminho");
}

/**
 * GET of a site fragment, with the user's session when there is one. Without it, Reddit now
 * sends many addresses to the login page (302) or answers 403: that becomes a clear error.
 */
async function getFragment(url: string, signal?: AbortSignal): Promise<HttpResponse> {
  const cookie = sessionCookie();
  let res: HttpResponse;
  try {
    res = await request(url, { browser: true, headers: cookie ? { cookie } : {}, cacheTtlMs: TTL.social, maxRetryWaitMs: 10_000, signal });
  } catch (err) {
    if (!cookie && /HTTP 403/.test(String(err))) throw new Error(BLOCK_NOTE);
    throw err;
  }
  if (!res.url.includes("/svc/shreddit/")) {
    throw new Error(cookie ? "o Reddit mandou a busca do site para outra página mesmo com a sessão (confira REDDIT_COOKIE)" : BLOCK_NOTE);
  }
  assertNotChallenge(res.text);
  return res;
}

/**
 * Vote and comment counts next to a <faceplate-number>. The word after the number follows the
 * account's language ("votes", "votos", "comentários"), so it is matched by its start.
 */
export function counts(chunk: string): { vote?: number; comment?: number } {
  const out: { vote?: number; comment?: number } = {};
  for (const c of chunk.matchAll(/<faceplate-number\b[^>]*?\bnumber="(\d+)"[^>]*>\s*<\/faceplate-number>\s*([\p{L}]+)/gu)) {
    const word = c[2]!.toLowerCase();
    if (/^(vote|voto|upvote|point|punto)/.test(word)) out.vote ??= Number(c[1]);
    else if (/^(comment|coment)/.test(word)) out.comment ??= Number(c[1]);
  }
  return out;
}

function searchCursor(html: string): string | undefined {
  const partial = /<faceplate-partial\b[^>]*?\bsrc="([^"]*\/svc\/shreddit\/[^"]*search\/[^"]*)"/.exec(html)?.[1];
  return partial ? (new URL(decodeEntities(partial), BASE).searchParams.get("cursor") ?? undefined) : undefined;
}

// ---------- search ----------

export function parseSearchPage(html: string): { posts: ShredditPost[]; cursor?: string } {
  const units: Array<{ index: number; ctx: { post: { id: string; title?: string }; subreddit?: { name?: string } } }> = [];
  for (const m of html.matchAll(/<search-telemetry-tracker\b[^>]*?\bdata-faceplate-tracking-context="([^"]*)"/g)) {
    try {
      const ctx = JSON.parse(decodeEntities(m[1]!)) as { action_info?: { type?: string }; post?: { id?: string; title?: string }; subreddit?: { name?: string } };
      if (ctx.action_info?.type === "post" && ctx.post?.id) units.push({ index: m.index!, ctx: ctx as (typeof units)[number]["ctx"] });
    } catch {
      // a tracker we do not understand
    }
  }
  const posts: ShredditPost[] = [];
  const seen = new Set<string>();
  units.forEach((u, i) => {
    const id = u.ctx.post.id.replace(/^t3_/, "");
    if (seen.has(id)) return;
    seen.add(id);
    const chunk = html.slice(u.index, units[i + 1]?.index ?? html.length);
    const sub = u.ctx.subreddit?.name ?? "";
    const href = /<a\b[^>]*?data-testid="post-title"[^>]*?\bhref="([^"]*)"|<a\b[^>]*?\bhref="([^"]*)"[^>]*?data-testid="post-title"/.exec(chunk);
    const path = decodeEntities(href?.[1] ?? href?.[2] ?? "").split("?")[0] ?? "";
    const n = counts(chunk);
    posts.push({
      id,
      // The tracker carries the original title; the visible one may be Reddit's machine translation.
      title: decodeEntities(u.ctx.post.title ?? ""),
      url: path.includes(`/comments/${id}/`) ? `${BASE}${path}` : `${BASE}/r/${sub}/comments/${id}/`,
      subreddit: sub,
      score: n.vote,
      comments: n.comment,
      created: /<faceplate-timeago\b[^>]*?\bts="([^"]+)"/.exec(chunk)?.[1],
    });
  });
  return { posts, cursor: searchCursor(html) };
}

export interface ShredditCommentHit {
  id: string;
  postId: string;
  subreddit: string;
  /** Original title of the thread (from the tracker, never translated). */
  postTitle: string;
  author?: string;
  score?: number;
  created?: string;
  /** The text as the page shows it: Reddit may have machine-translated it to the account's language. */
  shownText: string;
  url: string;
}

/** Comment results of the site search (type=comments). Each comment has several trackers; the first one opens its block. */
export function parseCommentSearch(html: string): { comments: ShredditCommentHit[]; cursor?: string } {
  const starts: Array<{ index: number; ctx: { comment: { id: string; post_id?: string }; post?: { id?: string; title?: string }; subreddit?: { name?: string } } }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<search-telemetry-tracker\b[^>]*?\bdata-faceplate-tracking-context="([^"]*)"/g)) {
    try {
      const ctx = JSON.parse(decodeEntities(m[1]!)) as (typeof starts)[number]["ctx"];
      if (!ctx.comment?.id || seen.has(ctx.comment.id)) continue;
      seen.add(ctx.comment.id);
      starts.push({ index: m.index!, ctx });
    } catch {
      // a tracker we do not understand
    }
  }
  const comments = starts.map((s, i): ShredditCommentHit => {
    const chunk = html.slice(s.index, starts[i + 1]?.index ?? html.length);
    const thing = s.ctx.comment.id;
    const id = thing.replace(/^t1_/, "");
    const postId = (s.ctx.comment.post_id ?? s.ctx.post?.id ?? "").replace(/^t3_/, "");
    const sub = s.ctx.subreddit?.name ?? "";
    const marker = chunk.indexOf(`id="search-comment-${thing}-post-rtjson-content"`);
    let shownText = "";
    if (marker >= 0) {
      const start = chunk.indexOf(">", marker) + 1;
      const end = chunk.indexOf("</div>", start);
      shownText = stripTags(chunk.slice(start, end > 0 ? end : start + 4000));
    }
    const href = new RegExp(`href="(/r/[^"]*/comments/${postId}/[^"]*/${id}/)"`).exec(chunk)?.[1];
    return {
      id,
      postId,
      subreddit: sub,
      postTitle: decodeEntities(s.ctx.post?.title ?? ""),
      author: decodeEntities(/user-hover-card\/([^?"/]+)\?commentId=/.exec(chunk)?.[1] ?? "") || undefined,
      score: counts(chunk).vote,
      created: /<faceplate-timeago\b[^>]*?\bts="([^"]+)"/.exec(chunk)?.[1],
      shownText,
      url: href ? `${BASE}${href}` : `${BASE}/r/${sub}/comments/${postId}/comment/${id}/`,
    };
  });
  return { comments: comments.filter((c) => c.postId), cursor: searchCursor(html) };
}

function timeFilter(days?: number): string {
  if (!days) return "all";
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 365) return "year";
  return "all";
}

export async function shredditSearch(query: string, opts: { subreddit?: string; sinceDays?: number; limit: number; signal?: AbortSignal }): Promise<SearchHit[]> {
  const path = opts.subreddit ? `/svc/shreddit/r/${encodeURIComponent(opts.subreddit)}/search/` : "/svc/shreddit/search/";
  const posts: ShredditPost[] = [];
  let cursor: string | undefined;
  // About 7 posts per page; a few pages cover a normal limit.
  for (let page = 0; page < Math.min(4, Math.ceil(opts.limit / 7)) && (page === 0 || cursor); page++) {
    const params = new URLSearchParams({ q: query, type: "posts", t: timeFilter(opts.sinceDays), sort: "relevance" });
    if (cursor) params.set("cursor", cursor);
    const res = await getFragment(`${BASE}${path}?${params}`, opts.signal);
    const parsed = parseSearchPage(res.text);
    if (!parsed.posts.length && !res.text.includes('view-events="search/view/no_results"') && page === 0) {
      throw new Error("a página de busca do Reddit mudou (nenhum resultado reconhecido)");
    }
    posts.push(...parsed.posts);
    cursor = parsed.cursor;
  }
  return posts.slice(0, opts.limit).map((p) => ({
    url: p.url,
    title: p.title,
    source: "reddit" as const,
    provider: "reddit-web",
    published: isoDate(p.created),
    metrics: { score: p.score, comments: p.comments },
    tags: [`r/${p.subreddit}`],
  }));
}

/** Comments that mention the words, across Reddit (site search, type=comments). About 8 per page. */
export async function shredditCommentSearch(
  query: string,
  opts: { subreddit?: string; sinceDays?: number; limit: number; signal?: AbortSignal },
): Promise<ShredditCommentHit[]> {
  const path = opts.subreddit ? `/svc/shreddit/r/${encodeURIComponent(opts.subreddit)}/search/` : "/svc/shreddit/search/";
  const out: ShredditCommentHit[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < Math.min(4, Math.ceil(opts.limit / 8)) && (page === 0 || cursor); page++) {
    const params = new URLSearchParams({ q: query, type: "comments", t: timeFilter(opts.sinceDays), sort: "relevance" });
    if (cursor) params.set("cursor", cursor);
    const res = await getFragment(`${BASE}${path}?${params}`, opts.signal);
    const parsed = parseCommentSearch(res.text);
    if (!parsed.comments.length && !res.text.includes("no_results") && page === 0) {
      throw new Error("a página de busca de comentários do Reddit mudou (nenhum comentário reconhecido)");
    }
    out.push(...parsed.comments);
    cursor = parsed.cursor;
  }
  return out.slice(0, opts.limit);
}

// ---------- subreddit listing ----------

export function parseListing(html: string): ShredditPost[] {
  return findStartTags(html, "shreddit-post")
    .map(({ tag }) => {
      const permalink = attr(tag, "permalink") ?? "";
      const id = /\/comments\/([a-z0-9]+)/i.exec(permalink)?.[1] ?? "";
      return {
        id,
        title: attr(tag, "post-title") ?? "",
        url: `${BASE}${permalink}`,
        subreddit: attr(tag, "subreddit-name") ?? "",
        score: num(attr(tag, "score")),
        comments: num(attr(tag, "comment-count")),
        created: attr(tag, "created-timestamp"),
        author: attr(tag, "author"),
      };
    })
    .filter((p) => p.id);
}

export async function shredditListing(subreddit: string, sort: "top" | "hot" | "new" = "top", sinceDays?: number, signal?: AbortSignal): Promise<ShredditPost[]> {
  const params = new URLSearchParams({ name: subreddit });
  if (sort === "top") params.set("t", timeFilter(sinceDays));
  const res = await getFragment(`${BASE}/svc/shreddit/community-more-posts/${sort}/?${params}`, signal);
  return parseListing(res.text);
}

/**
 * A subreddit's feed (new, hot or top) through the subreddit's own search with q="*". Unlike the
 * listing above, the search carries the original titles: the listing shows Reddit's machine
 * translation when the account is set to another language. About 8 posts per page.
 */
export async function shredditSubredditFeed(
  subreddit: string,
  sort: "new" | "hot" | "top",
  opts: { sinceDays?: number; limit: number; signal?: AbortSignal },
): Promise<ShredditPost[]> {
  const path = `/svc/shreddit/r/${encodeURIComponent(subreddit)}/search/`;
  const posts: ShredditPost[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < Math.min(4, Math.ceil(opts.limit / 7)) && (page === 0 || cursor); page++) {
    const params = new URLSearchParams({ q: "*", type: "posts", t: timeFilter(opts.sinceDays), sort });
    if (cursor) params.set("cursor", cursor);
    const res = await getFragment(`${BASE}${path}?${params}`, opts.signal);
    const parsed = parseSearchPage(res.text);
    if (!parsed.posts.length && page === 0 && !res.text.includes('view-events="search/view/no_results"')) {
      throw new Error("a página do subreddit no site do Reddit mudou (nenhum post reconhecido)");
    }
    for (const p of parsed.posts) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      posts.push(p);
    }
    cursor = parsed.cursor;
  }
  return posts.slice(0, opts.limit);
}

// ---------- comments ----------

export function parseComments(html: string): ShredditComment[] {
  return findStartTags(html, "shreddit-comment").map(({ tag, index }) => {
    const thing = attr(tag, "thingId") ?? `t1_${/\/comment\/([a-z0-9]+)/i.exec(attr(tag, "permalink") ?? "")?.[1] ?? ""}`;
    // The body lives in <div id="{thingId}-post-rtjson-content">…</div> after the start tag.
    const marker = html.indexOf(`id="${thing}-post-rtjson-content"`, index);
    let text = "";
    if (marker > 0) {
      const start = html.indexOf(">", marker) + 1;
      const end = html.indexOf("</div>", start);
      text = stripTags(html.slice(start, end > 0 ? end : start + 4000));
    }
    return {
      id: thing.replace(/^t1_/, ""),
      author: attr(tag, "author"),
      score: num(attr(tag, "score")),
      created: attr(tag, "created"),
      depth: num(attr(tag, "depth")) ?? 0,
      text,
    };
  });
}

export async function shredditComments(subreddit: string, postId: string, signal?: AbortSignal): Promise<{ comments: ShredditComment[]; total?: number }> {
  const res = await getFragment(`${BASE}/svc/shreddit/comments/r/${encodeURIComponent(subreddit)}/t3_${postId}?sort=top`, signal);
  const total = num(/\btotal-comments="(\d+)"/.exec(res.text)?.[1]);
  return { comments: parseComments(res.text).filter((c) => c.text && c.author !== "AutoModerator"), total };
}

export function commentsMarkdown(comments: ShredditComment[], max: number): string[] {
  return comments.slice(0, max).map((c) => `${"  ".repeat(Math.min(c.depth, 3))}- **${c.author ?? "?"}** (▲${c.score ?? 0}): ${oneLine(c.text, 700)}`);
}
