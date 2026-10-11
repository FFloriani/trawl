import { config } from "../config.ts";
import { htmlToMarkdown } from "../core/extract.ts";
import { getJson, setHostInterval, TTL } from "../core/http.ts";
import type { Connector, ReadResult, SearchHit, SearchQuery } from "../core/types.ts";
import { daysAgoDate, errMessage, isoDate, oneLine, stripTags, truncate, ymd } from "../core/util.ts";

// Discourse forums expose a public JSON search with date operators, no key needed. There is
// no default forum: each research picks the forums of its subject (trawl_plan forums=[…] or
// "forum:host" in the query), and TRAWL_FORUMS lists forums to search every time.

interface DiscoursePost {
  topic_id: number;
  post_number: number;
  blurb?: string;
  like_count?: number;
  created_at?: string;
  username?: string;
}

interface DiscourseTopic {
  id: number;
  slug: string;
  title: string;
  posts_count?: number;
  created_at?: string;
  tags?: Array<string | { name?: string }>;
}

export function forumHosts(): string[] {
  return config.forums;
}

// Hosts used in this process, so a topic URL found by a search is read through the API too.
const usedHosts = new Set<string>();

const HOST_RE = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

export function forumHostsIn(query: string): string[] {
  return [...query.matchAll(/\bforum:(\S+)/g)].map((m) => m[1]!.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase());
}

async function searchForum(host: string, query: string, limit: number, sinceDays?: number, signal?: AbortSignal): Promise<SearchHit[]> {
  usedHosts.add(host);
  setHostInterval(host, 800);
  const q = sinceDays ? `${query} after:${ymd(daysAgoDate(sinceDays))}` : query;
  const data = await getJson<{ posts?: DiscoursePost[]; topics?: DiscourseTopic[] }>(
    `https://${host}/search.json?${new URLSearchParams({ q })}`,
    { browser: true, cacheTtlMs: TTL.social, signal },
  );
  const topics = new Map((data.topics ?? []).map((t) => [t.id, t]));
  const seen = new Set<number>();
  const hits: SearchHit[] = [];
  for (const p of data.posts ?? []) {
    const t = topics.get(p.topic_id);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    const topicCreated = t.created_at?.slice(0, 10);
    const postDate = p.created_at?.slice(0, 10);
    hits.push({
      url: `https://${host}/t/${t.slug}/${t.id}`,
      title: t.title,
      snippet: oneLine(stripTags(p.blurb ?? ""), 400),
      source: "forums",
      provider: host,
      // The matching post is what falls inside the window; an old topic can have a fresh reply.
      published: isoDate(p.created_at),
      author: p.username,
      metrics: { likes: p.like_count, replies: t.posts_count ? t.posts_count - 1 : undefined },
      tags: [
        host,
        topicCreated && postDate && topicCreated !== postDate ? `tópico de ${topicCreated}, post de ${postDate}` : "",
        ...(t.tags ?? []).slice(0, 3).map((x) => (typeof x === "string" ? x : (x.name ?? ""))),
      ].filter(Boolean),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export const forums: Connector = {
  name: "forums",
  label: "Fóruns Discourse do assunto",
  async availability() {
    const fixed = forumHosts();
    if (fixed.length) return { ok: true, mode: `busca pública sem chave; sempre em: ${fixed.join(", ")}; cada pesquisa pode somar os seus` };
    return {
      ok: false,
      mode: "sem fórum fixo: cada pesquisa escolhe os fóruns do assunto",
      enable: "Na pesquisa: trawl_plan com forums=[\"discuss.python.org\"] ou forum:host na consulta. Para sempre: TRAWL_FORUMS=host1,host2",
    };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const picked = forumHostsIn(q.query);
    const text = q.query.replace(/\bforum:\S+/g, "").replace(/\s+/g, " ").trim();
    const hosts = [...new Set(picked.length ? picked : forumHosts())];
    if (!hosts.length) throw new Error("nenhum fórum escolhido: use forum:host na consulta (ex.: forum:discuss.python.org) ou forums no trawl_plan");
    const bad = hosts.filter((h) => !HOST_RE.test(h));
    if (bad.length) throw new Error(`host de fórum inválido: ${bad.join(", ")}`);
    const settled = await Promise.allSettled(hosts.map((h) => searchForum(h, text, q.limit, q.sinceDays, q.signal)));
    const hits = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (!hits.length) {
      const errors = settled.filter((s) => s.status === "rejected").map((s) => errMessage((s as PromiseRejectedResult).reason));
      if (errors.length === settled.length) throw new Error(errors.join(" | "));
    }
    return hits;
  },
};

export function isForumTopic(url: URL): boolean {
  return (forumHosts().includes(url.hostname) || usedHosts.has(url.hostname)) && /^\/t\/(?:[^/]+\/)?\d+/.test(url.pathname);
}

interface TopicJson {
  id: number;
  slug?: string;
  title: string;
  created_at?: string;
  posts_count?: number;
  views?: number;
  like_count?: number;
  post_stream?: {
    posts: Array<{
      username?: string;
      created_at?: string;
      cooked?: string;
      post_number: number;
      actions_summary?: Array<{ id: number; count?: number }>;
    }>;
  };
}

export async function readForumTopic(url: URL, maxReplies = 25): Promise<ReadResult> {
  const id = /\/t\/(?:[^/]+\/)?(\d+)/.exec(url.pathname)?.[1];
  const topic = await getJson<TopicJson>(`https://${url.hostname}/t/${id}.json`, { browser: true, cacheTtlMs: TTL.social });
  const posts = topic.post_stream?.posts ?? [];
  const likes = (p: (typeof posts)[number]) => p.actions_summary?.find((a) => a.id === 2)?.count ?? 0;
  const body = (p: (typeof posts)[number]) => htmlToMarkdown(`<html><body><article>${p.cooked ?? ""}</article></body></html>`, url.toString()).markdown;
  const [first, ...replies] = posts;
  const top = [...replies].sort((a, b) => likes(b) - likes(a)).slice(0, maxReplies);
  return {
    // Same shape as the search results, so a read topic keeps the source id it was found with.
    url: topic.slug ? `https://${url.hostname}/t/${topic.slug}/${id}` : `https://${url.hostname}/t/${id}`,
    title: topic.title,
    source: "forums",
    published: isoDate(topic.created_at),
    author: first?.username,
    metrics: { likes: topic.like_count, replies: topic.posts_count ? topic.posts_count - 1 : undefined, views: topic.views },
    note: posts.length < (topic.posts_count ?? 0) ? `Lidas as primeiras ${posts.length} de ${topic.posts_count} mensagens.` : undefined,
    content: [
      `${url.hostname} · ${topic.posts_count ?? "?"} mensagens · ${topic.views ?? "?"} visualizações`,
      "",
      first ? truncate(body(first), 6000) : "",
      "",
      "## Respostas mais curtidas",
      ...top.map((p) => `- **${p.username ?? "?"}** (♥${likes(p)}, ${p.created_at?.slice(0, 10) ?? ""}): ${truncate(body(p).replace(/\s+/g, " "), 700)}`),
    ].join("\n"),
  };
}
