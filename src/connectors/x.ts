import { config } from "../config.ts";
import { getJson, TTL } from "../core/http.ts";
import type { Availability, Connector, ReadResult, SearchHit, SearchQuery } from "../core/types.ts";
import { compactNumber, daysAgoDate, errMessage, isoDate, oneLine, ymd } from "../core/util.ts";
import { searchTwitterApiIo, twapiCredits, twapiTopReplies } from "./x-twitterapi.ts";

// Search backends, all opt-in with keys, cheapest first:
//  - twitterapi.io (TWITTERAPI_IO_KEY): ~US$0.15 per 1,000 posts, full metrics (x-twitterapi.ts).
//  - X API v2 recent search (X_BEARER_TOKEN): raw posts with real metrics, last 7 days only.
//  - xAI Responses API with the x_search tool (XAI_API_KEY): Grok searches X and we ask it
//    for a JSON list of posts. Wider window, but the list passes through an LLM, so every
//    post is tagged for verification.
// Cookie-based scraping is deliberately not implemented: it needs faking X's anti-bot header and
// risks the user's account. Reading single posts goes through FxTwitter, free and keyless.

const POST_URL = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

async function searchXApi(q: SearchQuery): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    query: `${q.query} -is:retweet`,
    max_results: String(Math.max(10, Math.min(q.limit, 100))),
    sort_order: "relevancy",
    "tweet.fields": "created_at,public_metrics,author_id,lang",
    expansions: "author_id",
    "user.fields": "username,name",
  });
  if (q.sinceDays && q.sinceDays < 7) params.set("start_time", daysAgoDate(q.sinceDays).toISOString());
  const data = await getJson<{
    data?: Array<{
      id: string;
      text: string;
      created_at?: string;
      author_id?: string;
      public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; impression_count?: number };
    }>;
    includes?: { users?: Array<{ id: string; username: string; name?: string }> };
  }>(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { authorization: `Bearer ${config.keys.xBearer}` },
    cacheTtlMs: TTL.social,
    signal: q.signal,
  });
  const users = new Map((data.includes?.users ?? []).map((u) => [u.id, u.username]));
  return (data.data ?? []).slice(0, q.limit).map((t) => {
    const user = (t.author_id && users.get(t.author_id)) || "i";
    return {
      url: `https://x.com/${user}/status/${t.id}`,
      title: oneLine(t.text, 140),
      snippet: oneLine(t.text, 400),
      source: "x",
      provider: "x-api",
      published: isoDate(t.created_at),
      author: user === "i" ? undefined : `@${user}`,
      metrics: {
        likes: t.public_metrics?.like_count,
        reposts: t.public_metrics?.retweet_count,
        replies: t.public_metrics?.reply_count,
        views: t.public_metrics?.impression_count,
      },
    };
  });
}

interface GrokPost {
  url?: string;
  author?: string;
  date?: string;
  text?: string;
  likes?: number;
  reposts?: number;
  replies?: number;
}

/** Collects every X post URL anywhere in the response (annotations, citations, text). */
export function collectPostUrls(node: unknown, out = new Set<string>()): Set<string> {
  if (typeof node === "string") {
    for (const m of node.matchAll(new RegExp(POST_URL, "g"))) out.add(`https://x.com/${m[1]}/status/${m[2]}`);
  } else if (Array.isArray(node)) {
    for (const v of node) collectPostUrls(v, out);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectPostUrls(v, out);
  }
  return out;
}

export function outputText(resp: unknown): string {
  const parts: string[] = [];
  const out = (resp as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }).output ?? [];
  for (const item of out) {
    for (const c of item.content ?? []) if (typeof c.text === "string") parts.push(c.text);
  }
  const direct = (resp as { output_text?: string }).output_text;
  if (!parts.length && typeof direct === "string") parts.push(direct);
  return parts.join("\n");
}

export function parseGrokPosts(text: string): GrokPost[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(arr) ? (arr as GrokPost[]) : [];
  } catch {
    return [];
  }
}

async function searchXai(q: SearchQuery): Promise<SearchHit[]> {
  const limit = Math.min(q.limit, 25);
  const tool: Record<string, unknown> = { type: "x_search" };
  if (q.sinceDays) tool.from_date = ymd(daysAgoDate(q.sinceDays));
  const prompt = [
    `Search X for posts about: ${q.query}`,
    `Return ONLY a JSON array with up to ${limit} of the most relevant and most engaged posts.`,
    `Each item: {"url": exact post URL, "author": "@handle", "date": "YYYY-MM-DD", "text": post text, "likes": number, "reposts": number, "replies": number}.`,
    "Use only posts you actually retrieved. No commentary outside the JSON.",
  ].join("\n");
  const resp = await getJson<unknown>("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${config.keys.xai}` },
    json: { model: config.xaiModel, input: [{ role: "user", content: prompt }], tools: [tool] },
    cacheTtlMs: TTL.social,
    timeoutMs: 120_000,
    retries: 1,
    signal: q.signal,
  });
  const cited = collectPostUrls(resp);
  const posts = parseGrokPosts(outputText(resp));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const p of posts) {
    const m = p.url ? POST_URL.exec(p.url) : null;
    if (!m) continue;
    const url = `https://x.com/${m[1]}/status/${m[2]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({
      url,
      title: oneLine(p.text ?? url, 140),
      snippet: oneLine(p.text, 400),
      source: "x",
      provider: "xai-grok",
      published: isoDate(p.date),
      author: p.author ?? `@${m[1]}`,
      metrics: { likes: p.likes, reposts: p.reposts, replies: p.replies },
      // A URL Grok listed but never cited is the riskiest kind of LLM output.
      tags: [cited.has(url) ? "citado pela busca do Grok" : "NÃO citado pelo Grok: verificar", "texto e números vieram de LLM"],
    });
  }
  for (const url of cited) {
    if (hits.length >= limit) break;
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, title: url, source: "x", provider: "xai-grok", tags: ["só a URL citada; leia o post"] });
  }
  return hits.slice(0, limit);
}

// ---------- connector ----------

type Backend = "twitterapi.io" | "x-api" | "xai";

function backends(): Array<[Backend, (q: SearchQuery) => Promise<SearchHit[]>]> {
  const list: Array<[Backend, (q: SearchQuery) => Promise<SearchHit[]>]> = [];
  if (config.keys.twitterapiIo) list.push(["twitterapi.io", searchTwitterApiIo]);
  if (config.keys.xBearer) list.push(["x-api", searchXApi]);
  if (config.keys.xai) list.push(["xai", searchXai]);
  return list;
}

export const x: Connector = {
  name: "x",
  label: "X (Twitter)",
  async availability(): Promise<Availability> {
    const b = backends().map(([id]) => id);
    if (b.length) {
      const credits = config.keys.twitterapiIo ? await twapiCredits() : undefined;
      // twitterapi.io with no credit answers 402 to every search: alone, the source is off until a recharge.
      if (credits?.empty && b.length === 1) {
        return {
          ok: false,
          mode: `twitterapi.io sem crédito (${credits.text}): busca no X desligada até recarregar; leitura de posts pelo FxTwitter continua grátis`,
          enable: "Recarregue em https://twitterapi.io/payment (cerca de US$0,15 por 1.000 posts), ou ponha XAI_API_KEY ou X_BEARER_TOKEN no .env da pasta de dados.",
        };
      }
      return { ok: true, mode: `busca por ${b.join(" → ")}${credits ? ` (${credits.text}${credits.empty ? ", sem crédito: pula para o próximo" : ""})` : ""}; leitura de posts pelo FxTwitter, grátis` };
    }
    return {
      ok: false,
      mode: "busca desligada; leitura de posts pelo FxTwitter funciona sem chave",
      enable:
        "Para buscar: TWITTERAPI_IO_KEY (twitterapi.io, ~US$0,15 por 1.000 posts), XAI_API_KEY (Grok x_search) ou X_BEARER_TOKEN (API oficial, ~US$0,005 por post) no .env da pasta de dados (trawl_doctor mostra onde).",
    };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const list = backends();
    if (!list.length) throw new Error("busca no X desligada: falta TWITTERAPI_IO_KEY, XAI_API_KEY ou X_BEARER_TOKEN (veja trawl_doctor)");
    const errors: string[] = [];
    for (const [id, fn] of list) {
      // The official API only covers 7 days, so longer windows skip it when another backend exists.
      if (id === "x-api" && (q.sinceDays ?? 7) > 7 && list.length > 1) continue;
      try {
        return await fn(q);
      } catch (err) {
        errors.push(`${id}: ${errMessage(err)}`);
      }
    }
    throw new Error(errors.join(" | "));
  },
};

// ---------- reading one post ----------

interface FxTweet {
  id: string;
  text: string;
  created_timestamp?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
  replying_to?: string | null;
  author?: { screen_name?: string; name?: string; followers?: number };
  quote?: { text?: string; author?: { screen_name?: string } } | null;
}

export async function readXPost(url: string): Promise<ReadResult> {
  const m = POST_URL.exec(url);
  if (!m) throw new Error("URL de post do X inválida");
  const user = m[1]!;
  const id = m[2]!;
  // FxTwitter reads public posts without login or cost.
  const fx = await getJson<{ tweet?: FxTweet }>(`https://api.fxtwitter.com/${user}/status/${id}`, { cacheTtlMs: TTL.social }).catch(() => undefined);
  const t = fx?.tweet;
  if (!t) throw new Error("não foi possível ler o post sem login (apagado, privado ou FxTwitter fora do ar); use o texto que veio na busca");
  const handle = t.author?.screen_name ?? user;
  let replies: string[] = [];
  let note: string | undefined;
  if (config.keys.twitterapiIo && !t.replying_to) {
    try {
      replies = await twapiTopReplies(id, 15);
    } catch (err) {
      note = `Respostas indisponíveis: ${errMessage(err)}`;
    }
  } else if (!config.keys.twitterapiIo) {
    note = "Sem TWITTERAPI_IO_KEY: só o post, sem as respostas.";
  }
  return {
    url: `https://x.com/${handle}/status/${id}`,
    title: oneLine(t.text, 140),
    source: "x",
    published: isoDate(t.created_timestamp),
    author: `@${handle}`,
    metrics: { likes: t.likes, reposts: t.retweets, replies: t.replies, views: t.views },
    note,
    content: [
      `@${handle}${t.author?.name ? ` (${t.author.name})` : ""}${t.author?.followers !== undefined ? ` · ${compactNumber(t.author.followers)} seguidores` : ""} · ♥${t.likes ?? 0} · ${t.retweets ?? 0} reposts · ${t.replies ?? 0} respostas · ${compactNumber(t.views)} views`,
      t.replying_to ? `Resposta a @${t.replying_to}` : "",
      "",
      t.text,
      t.quote?.text ? `\n> Citando @${t.quote.author?.screen_name ?? "?"}: ${oneLine(t.quote.text, 600)}` : "",
      ...(replies.length ? ["", "## Respostas mais curtidas (entre as mais recentes)", ...replies] : []),
    ].join("\n"),
  };
}

