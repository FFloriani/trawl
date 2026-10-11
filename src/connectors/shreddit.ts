import { request, TTL } from "../core/http.ts";
import type { SearchHit } from "../core/types.ts";
import { decodeEntities, isoDate, oneLine, stripTags } from "../core/util.ts";

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
    const counts: Record<string, number> = {};
    for (const c of chunk.matchAll(/<faceplate-number\b[^>]*?\bnumber="(\d+)"[^>]*>\s*<\/faceplate-number>\s*(vote|comment)/g)) {
      counts[c[2]!] ??= Number(c[1]);
    }
    posts.push({
      id,
      title: decodeEntities(u.ctx.post.title ?? ""),
      url: path.includes(`/comments/${id}/`) ? `${BASE}${path}` : `${BASE}/r/${sub}/comments/${id}/`,
      subreddit: sub,
      score: counts.vote,
      comments: counts.comment,
      created: /<faceplate-timeago\b[^>]*?\bts="([^"]+)"/.exec(chunk)?.[1],
    });
  });
  const partial = /<faceplate-partial\b[^>]*?\bsrc="([^"]*\/svc\/shreddit\/[^"]*search\/[^"]*)"/.exec(html)?.[1];
  const cursor = partial ? (new URL(decodeEntities(partial), BASE).searchParams.get("cursor") ?? undefined) : undefined;
  return { posts, cursor };
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
    const res = await request(`${BASE}${path}?${params}`, { browser: true, cacheTtlMs: TTL.social, maxRetryWaitMs: 10_000, signal: opts.signal });
    assertNotChallenge(res.text);
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
  const res = await request(`${BASE}/svc/shreddit/community-more-posts/${sort}/?${params}`, { browser: true, cacheTtlMs: TTL.social, maxRetryWaitMs: 10_000, signal });
  assertNotChallenge(res.text);
  return parseListing(res.text);
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
  const res = await request(`${BASE}/svc/shreddit/comments/r/${encodeURIComponent(subreddit)}/t3_${postId}?sort=top`, {
    browser: true,
    cacheTtlMs: TTL.social,
    maxRetryWaitMs: 10_000,
    signal,
  });
  assertNotChallenge(res.text);
  const total = num(/\btotal-comments="(\d+)"/.exec(res.text)?.[1]);
  return { comments: parseComments(res.text).filter((c) => c.text && c.author !== "AutoModerator"), total };
}

export function commentsMarkdown(comments: ShredditComment[], max: number): string[] {
  return comments.slice(0, max).map((c) => `${"  ".repeat(Math.min(c.depth, 3))}- **${c.author ?? "?"}** (▲${c.score ?? 0}): ${oneLine(c.text, 700)}`);
}
