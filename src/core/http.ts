import { createHash } from "node:crypto";
import { BROWSER_UA, userAgent } from "../config.ts";
import { cache } from "./cache.ts";
import { log } from "./log.ts";
import { sleep, truncate } from "./util.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryAfterSec: number | undefined;
  constructor(message: string, status: number, url: string, retryAfterSec?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  timeoutMs?: number;
  /** Extra attempts after the first one, for network errors, 429 and 5xx. */
  retries?: number;
  /** 0 disables the cache. Only 2xx responses are cached. */
  cacheTtlMs?: number;
  /** Present a browser User-Agent (generic page reads); APIs get the descriptive one. */
  browser?: boolean;
  maxBytes?: number;
  /** Longest server-requested wait (Retry-After) honored inside one call. */
  maxRetryWaitMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  text: string;
  truncated: boolean;
  fromCache: boolean;
}

// Minimum gap between two requests to the same host. Reddit's anonymous feeds and arXiv
// ban bursty clients, so they get the widest gaps.
const HOST_INTERVAL_MS: Record<string, number> = {
  // ~1 req/s keeps Reddit's web fragments under their 429 threshold (shared with the RSS feeds).
  "www.reddit.com": 1100,
  "oauth.reddit.com": 700,
  "export.arxiv.org": 3100,
  "api.github.com": 120,
  "hn.algolia.com": 100,
  "api.stackexchange.com": 150,
  "api.openalex.org": 120,
  "api.x.com": 1000,
  // twitterapi.io's free tier allows one request every 5 seconds (paid accounts get more).
  "api.twitterapi.io": 5100,
  "www.youtube.com": 1500,
  "skillsmp.com": 2100,
  "arctic-shift.photon-reddit.com": 1000,
  "api.pullpush.io": 1500,
};
const DEFAULT_INTERVAL_MS = 250;

/** Sets the gap for a host chosen at run time (e.g. a forum picked for one research). */
export function setHostInterval(host: string, ms: number): void {
  HOST_INTERVAL_MS[host] ??= ms;
}
const MAX_RETRY_WAIT_MS = 8000;

const nextSlot = new Map<string, number>();
// Hosts that told us (x-ratelimit-remaining: 0) to stop until a reset time.
const blockedUntil = new Map<string, number>();

// GitHub's search API has its own budget (30/min) separate from the core one (5000/h).
function limitKey(u: URL): string {
  return u.hostname === "api.github.com" && u.pathname.startsWith("/search/") ? `${u.hostname}:search` : u.hostname;
}

/** x-ratelimit-reset is "seconds until reset" on Reddit and an epoch timestamp on GitHub. */
function resetSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n > 1e9 ? Math.max(0, n - Date.now() / 1000) : n;
}

function noteRateHeaders(key: string, headers: Headers): void {
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = resetSeconds(headers.get("x-ratelimit-reset"));
  if (headers.has("x-ratelimit-remaining") && remaining < 1 && reset !== undefined) {
    blockedUntil.set(key, Date.now() + reset * 1000 + 250);
  }
}

async function waitForHost(host: string): Promise<void> {
  const interval = HOST_INTERVAL_MS[host] ?? DEFAULT_INTERVAL_MS;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  // Reserve the slot before sleeping so concurrent callers queue in order.
  nextSlot.set(host, at + interval);
  if (at > now) await sleep(at - now);
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

async function readBody(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const charset = /charset=([^;]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.trim().toLowerCase();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, buf.length - offset));
    buf.set(part, offset);
    offset += part.byteLength;
    if (offset >= buf.length) break;
  }
  return { text: decoder.decode(buf), truncated };
}

/** True when the response came from another host or path than the one asked for. */
export function redirectedAway(asked: string, final: string): boolean {
  try {
    const a = new URL(asked);
    const f = new URL(final);
    return a.hostname.replace(/^www\./, "") !== f.hostname.replace(/^www\./, "") || a.pathname.replace(/\/+$/, "") !== f.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

export async function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const method = opts.method ?? (opts.json !== undefined || opts.body !== undefined ? "POST" : "GET");
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body;
  const cacheTtl = opts.cacheTtlMs ?? 0;
  // The same URL answers differently with and without a session or key (Reddit sends a visitor to
  // the login page): the identity goes into the key, hashed so no secret reaches the cache.
  const identity = Object.entries(opts.headers ?? {})
    .filter(([k, v]) => v && /^(cookie|authorization|x-api-key)$/i.test(k))
    .map(([, v]) => v)
    .join("|");
  const cacheKey = `${method} ${url} ${body ?? ""}${identity ? ` as:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}` : ""}`;

  if (cacheTtl > 0) {
    const hit = await cache.get<HttpResponse>(cacheKey, cacheTtl);
    if (hit) return { ...hit, fromCache: true };
  }

  const headers: Record<string, string> = {
    "user-agent": opts.browser ? BROWSER_UA : userAgent(),
    "accept-language": "en-US,en;q=0.9,pt-BR;q=0.8",
    ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
    ...opts.headers,
  };
  const parsed = new URL(url);
  const host = parsed.hostname;
  const key = limitKey(parsed);
  const maxWait = opts.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS;
  const retries = opts.retries ?? 2;
  const maxBytes = opts.maxBytes ?? 6 * 1024 * 1024;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const blockedFor = (blockedUntil.get(key) ?? 0) - Date.now();
    if (blockedFor > 0) {
      // Waiting out a known window is cheaper than burning a request on a sure 429.
      if (blockedFor > maxWait) {
        throw new HttpError(`limite de pedidos de ${host} atingido; libera em ~${Math.ceil(blockedFor / 1000)} s`, 429, url, blockedFor / 1000);
      }
      await sleep(blockedFor);
    }
    await waitForHost(host);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: body ?? null, signal, redirect: "follow" });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err;
      log.debug(`network error ${host} (attempt ${attempt + 1})`, err);
      if (attempt < retries) await sleep(500 * 2 ** attempt);
      continue;
    }

    noteRateHeaders(key, res.headers);

    if (res.status === 429 || res.status >= 500) {
      // Reddit and GitHub announce the window in x-ratelimit-reset instead of Retry-After.
      const ra = retryAfterSeconds(res.headers.get("retry-after")) ?? resetSeconds(res.headers.get("x-ratelimit-reset"));
      await res.body?.cancel().catch(() => {});
      const hint = res.status === 429 ? `: limite de pedidos${ra !== undefined ? `, libera em ~${Math.ceil(ra)} s` : ""}` : "";
      lastError = new HttpError(`HTTP ${res.status} de ${host}${hint}`, res.status, url, ra);
      const wait = ra !== undefined ? ra * 1000 : 700 * 2 ** attempt + Math.random() * 300;
      // Long Retry-After values are returned to the caller instead of blocking the tool call.
      if (attempt >= retries || wait > maxWait) throw lastError;
      await sleep(wait);
      continue;
    }

    const { text, truncated } = await readBody(res, maxBytes);
    if (!res.ok) {
      // Some APIs (Arctic Shift) answer an exhausted budget with 422 + x-ratelimit-reset.
      const ra = retryAfterSeconds(res.headers.get("retry-after")) ?? resetSeconds(res.headers.get("x-ratelimit-reset"));
      throw new HttpError(`HTTP ${res.status} from ${host}: ${truncate(text.replace(/\s+/g, " "), 200)}`, res.status, url, ra);
    }
    const out: HttpResponse = {
      status: res.status,
      url: res.url || url,
      headers: Object.fromEntries(res.headers.entries()),
      text,
      truncated,
      fromCache: false,
    };
    // A redirect to another page (a login wall, a block page) is not the answer to this URL: never kept.
    if (cacheTtl > 0 && !redirectedAway(url, out.url)) await cache.set(cacheKey, out);
    return out;
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

export async function getJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, { ...opts, headers: { accept: "application/json", ...opts.headers } });
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new Error(`invalid JSON from ${new URL(url).hostname}: ${truncate(res.text, 120)}`);
  }
}

export const TTL = {
  search: 6 * 3600_000,
  page: 24 * 3600_000,
  social: 2 * 3600_000,
  none: 0,
} as const;
