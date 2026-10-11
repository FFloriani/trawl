import { getJson, TTL } from "../core/http.ts";
import type { Connector, ReadResult, SearchHit, SearchQuery } from "../core/types.ts";
import { isoDate, oneLine, stripTags, truncate } from "../core/util.ts";

const API = "https://hn.algolia.com/api/v1";

interface AlgoliaHit {
  objectID: string;
  title?: string;
  url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
  story_text?: string;
  comment_text?: string;
  story_title?: string;
  story_id?: number;
}

interface AlgoliaItem {
  id: number;
  title?: string;
  url?: string;
  author?: string;
  text?: string;
  points?: number;
  created_at?: string;
  type?: string;
  children?: AlgoliaItem[];
}

const itemUrl = (id: string | number) => `https://news.ycombinator.com/item?id=${id}`;

export const hackernews: Connector = {
  name: "hn",
  label: "Hacker News (Algolia)",
  async availability() {
    return { ok: true, mode: "Algolia HN API, sem chave" };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const params = new URLSearchParams({ query: q.query, tags: "story", hitsPerPage: String(Math.min(q.limit, 50)) });
    if (q.sinceDays) params.set("numericFilters", `created_at_i>${Math.floor(Date.now() / 1000 - q.sinceDays * 86400)}`);
    const data = await getJson<{ hits: AlgoliaHit[] }>(`${API}/search?${params}`, { cacheTtlMs: TTL.social, signal: q.signal });
    return data.hits.map((h) => ({
      url: itemUrl(h.objectID),
      title: h.title ?? "(sem título)",
      snippet: h.story_text ? oneLine(stripTags(h.story_text)) : h.url ? `link: ${h.url}` : undefined,
      source: "hn",
      provider: "algolia",
      published: isoDate(h.created_at),
      author: h.author,
      metrics: { score: h.points, comments: h.num_comments },
    }));
  },
};

function renderComments(children: AlgoliaItem[] | undefined, depth: number, budget: { left: number }, maxDepth: number): string[] {
  const out: string[] = [];
  for (const c of children ?? []) {
    if (budget.left <= 0) break;
    if (!c.text) continue;
    budget.left--;
    const indent = "  ".repeat(depth);
    out.push(`${indent}- **${c.author ?? "?"}** (${c.created_at?.slice(0, 10) ?? ""}): ${truncate(stripTags(c.text), 700)}`);
    if (depth + 1 < maxDepth) out.push(...renderComments(c.children, depth + 1, budget, maxDepth));
  }
  return out;
}

export async function readHnItem(id: string, maxComments = 40): Promise<ReadResult> {
  const item = await getJson<AlgoliaItem>(`${API}/items/${id}`, { cacheTtlMs: TTL.social });
  const lines: string[] = [];
  if (item.url) lines.push(`Link: ${item.url}`);
  if (item.text) lines.push("", stripTags(item.text));
  lines.push("", `## Comentários (até ${maxComments}, ordem do HN)`);
  lines.push(...renderComments(item.children, 0, { left: maxComments }, 3));
  return {
    url: itemUrl(id),
    title: item.title ?? `HN item ${id}`,
    source: "hn",
    published: isoDate(item.created_at),
    author: item.author,
    metrics: { score: item.points, comments: countComments(item.children) },
    content: lines.join("\n"),
  };
}

function countComments(children: AlgoliaItem[] | undefined): number {
  let n = 0;
  for (const c of children ?? []) n += 1 + countComments(c.children);
  return n;
}
