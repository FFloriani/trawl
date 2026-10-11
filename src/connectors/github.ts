import { githubToken } from "../config.ts";
import { getJson, request, TTL } from "../core/http.ts";
import type { Availability, Connector, ReadResult, SearchHit, SearchQuery } from "../core/types.ts";
import { callRemoteTool } from "../core/remote-mcp.ts";
import { daysAgoDate, errMessage, isoDate, oneLine, truncate, ymd } from "../core/util.ts";

const API = "https://api.github.com";

async function headers(accept = "application/vnd.github+json"): Promise<Record<string, string>> {
  const token = await githubToken();
  return {
    accept,
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function availability(): Promise<Availability> {
  const token = await githubToken();
  return token
    ? { ok: true, mode: "API REST com token (gh CLI ou GITHUB_TOKEN)" }
    : {
        ok: true,
        mode: "API REST sem token (10 buscas/min)",
        enable: "Rode `gh auth login` ou defina GITHUB_TOKEN para 30 buscas/min e busca de código.",
      };
}

interface Repo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
  created_at: string;
  language: string | null;
  topics?: string[];
  license?: { spdx_id?: string } | null;
  archived?: boolean;
  homepage?: string | null;
  owner?: { login: string };
  subscribers_count?: number;
}

interface Issue {
  html_url: string;
  title: string;
  body?: string | null;
  state: string;
  comments: number;
  created_at: string;
  updated_at?: string;
  user?: { login: string };
  pull_request?: unknown;
  reactions?: { total_count?: number };
  repository_url: string;
}

const sinceQualifier = (field: string, days?: number) => (days ? ` ${field}:>${ymd(daysAgoDate(days))}` : "");

// Star-farmed repos (often malware droppers) share a look: dozens of stars, no forks,
// an "HTML" codebase for something that claims to be a tool, SEO-style descriptions,
// and several siblings created the same day with the same star count.
const SEO_WORDS = /\b(best|top|free|official|ultimate|20\d\d|download|crack|working)\b/gi;

export function repoRedFlags(r: Pick<Repo, "stargazers_count" | "forks_count" | "language" | "description" | "created_at">, now = Date.now()): string[] {
  const flags: string[] = [];
  const ageDays = (now - Date.parse(r.created_at)) / 86_400_000;
  if (r.stargazers_count >= 30 && r.forks_count === 0) flags.push("estrelas sem nenhum fork");
  if (r.language === "HTML" && r.stargazers_count >= 20) flags.push("código é só HTML");
  if ((r.description?.match(SEO_WORDS)?.length ?? 0) >= 2) flags.push("descrição com cara de SEO");
  if (ageDays < 45 && r.stargazers_count >= 50 && r.forks_count <= 1) flags.push("estrelas rápidas demais para a idade");
  return flags;
}

/** Adds the sibling signal: same creation day and same star count with no forks. */
export function markStarClusters<T extends Pick<Repo, "created_at" | "stargazers_count" | "forks_count">>(repos: T[]): Map<T, boolean> {
  const groups = new Map<string, T[]>();
  for (const r of repos) {
    if (r.forks_count > 0 || r.stargazers_count < 20) continue;
    const key = `${r.created_at.slice(0, 10)}|${r.stargazers_count}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out = new Map<T, boolean>();
  for (const list of groups.values()) if (list.length >= 2) for (const r of list) out.set(r, true);
  return out;
}

export const githubRepos: Connector = {
  name: "github",
  label: "GitHub (repositórios)",
  availability,
  async search(q: SearchQuery): Promise<SearchHit[]> {
    // "sort:stars" (or forks/updated) in the query becomes the API's sort parameter.
    const sort = /\bsort:(stars|forks|updated)\b/.exec(q.query)?.[1];
    const text = q.query.replace(/\bsort:\S+/, "").trim();
    const fetchRepos = async (query: string, perPage: number, order?: string) => {
      const params = new URLSearchParams({ q: query, per_page: String(perPage) });
      if (order) params.set("sort", order);
      return (await getJson<{ items: Repo[] }>(`${API}/search/repositories?${params}`, { headers: await headers(), cacheTtlMs: TTL.search, signal: q.signal })).items;
    };
    // Over-fetch so the suspicious repos pushed to the bottom do not crowd out real ones.
    const relevant = await fetchRepos(text + sinceQualifier("pushed", q.sinceDays), Math.min(q.limit * 2, 50), sort);
    // With a window, relevance alone hides what is new; also take the window's newest repos by stars.
    let fresh: Repo[] = [];
    if (q.sinceDays && q.sinceDays <= 120 && !sort) {
      fresh = await fetchRepos(text + sinceQualifier("created", q.sinceDays), Math.min(q.limit, 30), "stars").catch(() => []);
    }
    const freshQuota = fresh.length ? Math.ceil(q.limit / 3) : 0;
    const byName = new Map<string, Repo>();
    for (const r of [...fresh.slice(0, freshQuota), ...relevant, ...fresh.slice(freshQuota)]) if (!byName.has(r.full_name)) byName.set(r.full_name, r);
    const items = [...byName.values()];
    const clusters = markStarClusters(items);
    const windowStart = q.sinceDays ? Date.now() - q.sinceDays * 86_400_000 : undefined;
    const hits = items.map((r) => {
      const flags = repoRedFlags(r);
      if (clusters.get(r)) flags.push("mesmo dia de criação e mesmas estrelas que outro repo da busca");
      const suspicious = flags.length >= 2;
      const isNew = windowStart !== undefined && Date.parse(r.created_at) >= windowStart;
      const hit: SearchHit = {
        url: r.html_url,
        title: r.full_name,
        snippet: oneLine(r.description ?? ""),
        source: "github",
        provider: "github-rest",
        metrics: { stars: r.stargazers_count, forks: r.forks_count },
        tags: [
          suspicious ? `⚠ SUSPEITO (provável repo de estrelas compradas): ${flags.join("; ")}` : "",
          isNew ? `NOVO: criado ${r.created_at.slice(0, 10)}` : `criado ${r.created_at.slice(0, 10)}`,
          `último push ${r.pushed_at.slice(0, 10)}`,
          r.language ?? "",
          r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : "sem licença",
          r.archived ? "ARQUIVADO" : "",
        ].filter(Boolean),
      };
      return { hit, suspicious };
    });
    return hits
      .sort((a, b) => Number(a.suspicious) - Number(b.suspicious))
      .slice(0, q.limit)
      .map((x) => x.hit);
  },
};

export const githubIssues: Connector = {
  name: "github_issues",
  label: "GitHub (issues e PRs)",
  availability,
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const query = q.query + sinceQualifier("created", q.sinceDays);
    const params = new URLSearchParams({ q: query, per_page: String(Math.min(q.limit, 50)) });
    const data = await getJson<{ items: Issue[] }>(`${API}/search/issues?${params}`, {
      headers: await headers(),
      cacheTtlMs: TTL.search,
      signal: q.signal,
    });
    return data.items.map((i) => ({
      url: i.html_url,
      title: i.title,
      snippet: oneLine(i.body ?? ""),
      source: "github_issues",
      provider: "github-rest",
      published: isoDate(i.created_at),
      author: i.user?.login,
      metrics: { comments: i.comments, likes: i.reactions?.total_count },
      tags: [i.repository_url.replace(`${API}/repos/`, ""), i.pull_request ? "PR" : "issue", i.state],
    }));
  },
};

// Code search, best first: grep.app (public MCP over ~1M repos, exact or regex, no key), then
// GitHub's own REST code search (needs a token; legacy index, no regex), then Sourcegraph's
// public stream API as the fallback. Results are merged by repo + path.
const GREP_APP_MCP = "https://mcp.grep.app";

/** Parses grep.app's text answer: blocks of Repository / Path / URL / License / Snippets. */
export function parseGrepApp(text: string): Array<{ repo: string; path: string; url: string; license?: string; snippet: string }> {
  return text
    .split(/\n(?=Repository: )/)
    .map((block) => {
      const field = (name: string) => new RegExp(`^${name}: (.+)$`, "m").exec(block)?.[1]?.trim();
      const snippet = block.split(/--- Snippet \d+[^\n]*---\n/)[1] ?? "";
      return { repo: field("Repository") ?? "", path: field("Path") ?? "", url: field("URL") ?? "", license: field("License"), snippet };
    })
    .filter((x) => x.repo && x.url);
}

/** "repo:o/r path:src lang:Lua termos" → grep.app's separate filter arguments. */
export function grepAppArgs(query: string): Record<string, unknown> {
  const take = (key: string) => new RegExp(`\\b${key}:(\\S+)`).exec(query)?.[1];
  const repo = take("repo");
  const path = take("path");
  const lang = take("lang") ?? take("language");
  const text = query.replace(/\b(repo|path|lang|language):\S+/g, "").replace(/\s+/g, " ").trim();
  return {
    query: text,
    useRegexp: /[\\^$|()[\]{}]/.test(text),
    ...(repo ? { repo } : {}),
    ...(path ? { path } : {}),
    ...(lang ? { language: [lang] } : {}),
  };
}

async function grepAppSearch(q: SearchQuery): Promise<SearchHit[]> {
  const text = await callRemoteTool(GREP_APP_MCP, "searchGitHub", grepAppArgs(q.query), 30_000);
  return parseGrepApp(text)
    .slice(0, q.limit)
    .map((m) => ({
      url: m.url,
      title: `${m.repo}: ${m.path}`,
      snippet: oneLine(m.snippet, 300),
      source: "github_code" as const,
      provider: "grep.app",
      tags: m.license && m.license !== "Unknown" ? [m.license] : [],
    }));
}

async function githubRestCodeSearch(q: SearchQuery): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: q.query, per_page: String(Math.min(q.limit, 30)) });
  const data = await getJson<{
    items: Array<{ path: string; html_url: string; repository: { full_name: string }; text_matches?: Array<{ fragment: string }> }>;
  }>(`${API}/search/code?${params}`, {
    headers: await headers("application/vnd.github.text-match+json"),
    cacheTtlMs: TTL.search,
    signal: q.signal,
  });
  return data.items.map((c) => ({
    url: c.html_url,
    title: `${c.repository.full_name}: ${c.path}`,
    snippet: oneLine(c.text_matches?.map((m) => m.fragment).join(" … ") ?? ""),
    source: "github_code" as const,
    provider: "github-rest",
  }));
}

async function sourcegraphSearch(q: SearchQuery): Promise<SearchHit[]> {
  const res = await request(
    `https://sourcegraph.com/.api/search/stream?${new URLSearchParams({ q: `${q.query} count:${Math.min(q.limit * 2, 50)}`, display: String(q.limit) })}`,
    { headers: { accept: "text/event-stream" }, cacheTtlMs: TTL.search, signal: q.signal },
  );
  const events = res.text
    .split("\n")
    .filter((l) => l.startsWith("data: ["))
    .flatMap((l) => {
      try {
        return JSON.parse(l.slice(6)) as Array<{ type: string; repository?: string; path?: string; repoStars?: number; lineMatches?: Array<{ line: string }>; chunkMatches?: Array<{ content: string }> }>;
      } catch {
        return [];
      }
    });
  return events
    .filter((m) => m.type === "content" && m.repository && m.path)
    .slice(0, q.limit)
    .map((m) => {
      const repo = m.repository!.replace(/^github\.com\//, "");
      return {
        url: m.repository!.startsWith("github.com/") ? `https://github.com/${repo}/blob/HEAD/${m.path}` : `https://${m.repository}/-/blob/${m.path}`,
        title: `${repo}: ${m.path}`,
        snippet: oneLine(m.lineMatches?.[0]?.line ?? m.chunkMatches?.[0]?.content ?? "", 300),
        source: "github_code" as const,
        provider: "sourcegraph",
        metrics: m.repoStars !== undefined ? { stars: m.repoStars } : undefined,
      };
    });
}

export const githubCode: Connector = {
  name: "github_code",
  label: "Código (grep.app, GitHub, Sourcegraph)",
  async availability() {
    const token = await githubToken();
    return { ok: true, mode: `grep.app (MCP público, regex)${token ? " + busca de código do GitHub com token" : ""}; Sourcegraph como reserva` };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const token = await githubToken();
    const settled = await Promise.allSettled([grepAppSearch(q), token ? githubRestCodeSearch(q) : Promise.resolve([])]);
    let hits = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (!hits.length) {
      try {
        hits = await sourcegraphSearch(q);
      } catch (err) {
        const errors = settled.filter((s) => s.status === "rejected").map((s) => errMessage((s as PromiseRejectedResult).reason));
        throw new Error([...errors, `sourcegraph: ${errMessage(err)}`].join(" | "));
      }
    }
    const seen = new Set<string>();
    return hits.filter((h) => !seen.has(h.title.toLowerCase()) && seen.add(h.title.toLowerCase())).slice(0, q.limit);
  },
};

// ---------- Discussions (GraphQL; REST search does not cover them) ----------

interface DiscussionNode {
  title: string;
  url: string;
  upvoteCount?: number;
  createdAt?: string;
  bodyText?: string;
  isAnswered?: boolean;
  author?: { login: string } | null;
  comments?: { totalCount: number };
  repository?: { nameWithOwner: string };
  category?: { name: string };
}

async function graphql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const token = await githubToken();
  if (!token) throw new Error("a API GraphQL do GitHub exige token (gh auth login ou GITHUB_TOKEN)");
  const res = await getJson<{ data?: T; errors?: Array<{ message: string }> }>(`${API}/graphql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    json: { query, variables },
    cacheTtlMs: TTL.search,
    signal,
  });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
  if (!res.data) throw new Error("GraphQL sem dados");
  return res.data;
}

export function discussionToHit(d: DiscussionNode): SearchHit {
  return {
    url: d.url,
    title: d.title,
    snippet: oneLine(d.bodyText ?? ""),
    source: "github_discussions",
    provider: "github-graphql",
    published: isoDate(d.createdAt),
    author: d.author?.login,
    metrics: { likes: d.upvoteCount, comments: d.comments?.totalCount },
    tags: [d.repository?.nameWithOwner ?? "", d.category?.name ?? "", d.isAnswered ? "respondida" : ""].filter(Boolean),
  };
}

export const githubDiscussions: Connector = {
  name: "github_discussions",
  label: "GitHub (Discussions)",
  async availability() {
    return (await githubToken())
      ? { ok: true, mode: "API GraphQL com token" }
      : { ok: false, mode: "desligado", enable: "Rode `gh auth login` ou defina GITHUB_TOKEN para buscar em Discussions." };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const data = await graphql<{ search: { nodes: DiscussionNode[] } }>(
      `query($q: String!, $n: Int!) { search(query: $q, type: DISCUSSION, first: $n) { nodes { ... on Discussion {
        title url upvoteCount createdAt bodyText isAnswered author { login } comments { totalCount }
        repository { nameWithOwner } category { name } } } } }`,
      { q: q.query + sinceQualifier("created", q.sinceDays), n: Math.min(q.limit, 50) },
      q.signal,
    );
    return data.search.nodes.filter((d) => d?.url).map(discussionToHit);
  },
};

export async function readGithubDiscussion(owner: string, repo: string, num: string, maxComments = 25): Promise<ReadResult> {
  const data = await graphql<{
    repository: {
      discussion: DiscussionNode & {
        body?: string;
        answer?: { author?: { login: string } | null; bodyText?: string; upvoteCount?: number } | null;
        comments: { totalCount: number; nodes: Array<{ author?: { login: string } | null; bodyText?: string; upvoteCount?: number; createdAt?: string }> };
      } | null;
    };
  }>(
    `query($o: String!, $r: String!, $n: Int!, $c: Int!) { repository(owner: $o, name: $r) { discussion(number: $n) {
      title url upvoteCount createdAt bodyText isAnswered author { login } category { name }
      answer { author { login } bodyText upvoteCount }
      comments(first: $c) { totalCount nodes { author { login } bodyText upvoteCount createdAt } } } } }`,
    { o: owner, r: repo, n: Number(num), c: Math.min(maxComments * 2, 100) },
  );
  const d = data.repository.discussion;
  if (!d) throw new Error(`discussion ${owner}/${repo}#${num} não encontrada`);
  const top = [...d.comments.nodes].sort((a, b) => (b.upvoteCount ?? 0) - (a.upvoteCount ?? 0)).slice(0, maxComments);
  return {
    url: d.url,
    title: d.title,
    source: "github_discussions",
    published: isoDate(d.createdAt),
    author: d.author?.login,
    metrics: { likes: d.upvoteCount, comments: d.comments.totalCount },
    content: [
      `${owner}/${repo} · ${d.category?.name ?? ""} · ▲${d.upvoteCount ?? 0} · ${d.comments.totalCount} comentários${d.isAnswered ? " · respondida" : ""}`,
      "",
      truncate(d.bodyText ?? "", 5000),
      d.answer ? `\n## Resposta aceita (${d.answer.author?.login ?? "?"}, ▲${d.answer.upvoteCount ?? 0})\n${truncate(d.answer.bodyText ?? "", 2000)}` : "",
      "",
      "## Comentários mais votados",
      ...top.map((c) => `- **${c.author?.login ?? "?"}** (▲${c.upvoteCount ?? 0}): ${truncate((c.bodyText ?? "").replace(/\s+/g, " "), 700)}`),
    ].join("\n"),
  };
}

/** Drops badge rows, images and raw HTML so the README costs fewer tokens. */
export function cleanReadme(md: string): string {
  return md
    .split("\n")
    .filter((line) => !/^\s*(\[?!\[[^\]]*\]\([^)]*\)\]?(\([^)]*\))?\s*)+$/.test(line))
    .join("\n")
    .replace(/<\/?(div|p|img|br|a|picture|source|h\d|sup|sub|details|summary)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readGithubRepo(owner: string, repo: string, maxReadme = 8000): Promise<ReadResult> {
  const h = await headers();
  const r = await getJson<Repo>(`${API}/repos/${owner}/${repo}`, { headers: h, cacheTtlMs: TTL.search });
  const [readme, releases] = await Promise.all([
    request(`${API}/repos/${owner}/${repo}/readme`, {
      headers: await headers("application/vnd.github.raw"),
      cacheTtlMs: TTL.page,
    })
      .then((res) => res.text)
      .catch(() => ""),
    getJson<Array<{ tag_name: string; published_at: string; name?: string }>>(
      `${API}/repos/${owner}/${repo}/releases?per_page=3`,
      { headers: h, cacheTtlMs: TTL.search },
    ).catch(() => []),
  ]);
  const daysSincePush = Math.round((Date.now() - Date.parse(r.pushed_at)) / 86_400_000);
  const flags = repoRedFlags(r);
  if (r.stargazers_count >= 30 && r.subscribers_count === 0) flags.push("ninguém acompanha (0 watchers)");
  const lines = [
    `**${r.full_name}** — ${r.description ?? ""}`,
    flags.length >= 2
      ? `\n> ⚠ SUSPEITO, provável repositório de estrelas compradas (às vezes usado para espalhar malware): ${flags.join("; ")}. Não recomende nem rode nada daqui sem checar o código.`
      : "",
    "",
    `- Estrelas: ${r.stargazers_count} · Forks: ${r.forks_count} · Watchers: ${r.subscribers_count ?? "?"} · Issues abertas: ${r.open_issues_count}`,
    `- Último push: ${r.pushed_at.slice(0, 10)} (${daysSincePush} dias) · Criado: ${r.created_at.slice(0, 10)}`,
    `- Licença: ${r.license?.spdx_id ?? "nenhuma"} · Linguagem: ${r.language ?? "?"}${r.archived ? " · **ARQUIVADO**" : ""}`,
    r.topics?.length ? `- Tópicos: ${r.topics.join(", ")}` : "",
    r.homepage ? `- Site: ${r.homepage}` : "",
    releases.length
      ? `- Releases: ${releases.map((x) => `${x.tag_name} (${x.published_at?.slice(0, 10)})`).join(", ")}`
      : "- Releases: nenhuma",
    "",
    "## README",
    truncate(cleanReadme(readme), maxReadme),
  ];
  return {
    url: r.html_url,
    title: r.full_name,
    source: "github",
    published: isoDate(r.pushed_at),
    author: r.owner?.login,
    metrics: { stars: r.stargazers_count, forks: r.forks_count },
    content: lines.filter((l) => l !== "").join("\n"),
  };
}

export async function readGithubIssue(owner: string, repo: string, num: string, maxComments = 30): Promise<ReadResult> {
  const h = await headers();
  const issue = await getJson<Issue>(`${API}/repos/${owner}/${repo}/issues/${num}`, { headers: h, cacheTtlMs: TTL.social });
  const comments = await getJson<Array<{ user?: { login: string }; body?: string; created_at: string; reactions?: { total_count?: number } }>>(
    `${API}/repos/${owner}/${repo}/issues/${num}/comments?per_page=${maxComments}`,
    { headers: h, cacheTtlMs: TTL.social },
  ).catch(() => []);
  const lines = [
    `Estado: ${issue.state} · Comentários: ${issue.comments} · Reações: ${issue.reactions?.total_count ?? 0}`,
    "",
    truncate(issue.body ?? "", 4000),
    "",
    "## Comentários",
    ...comments.map((c) => `- **${c.user?.login ?? "?"}** (${c.created_at.slice(0, 10)}): ${truncate((c.body ?? "").replace(/\s+/g, " "), 800)}`),
  ];
  return {
    url: issue.html_url,
    title: issue.title,
    source: "github_issues",
    published: isoDate(issue.created_at),
    author: issue.user?.login,
    metrics: { comments: issue.comments, likes: issue.reactions?.total_count },
    content: lines.join("\n"),
  };
}
