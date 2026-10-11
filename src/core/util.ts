import { createHash, randomBytes } from "node:crypto";

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|mc_cid|mc_eid|ref|ref_src|ref_url|igshid|si|share_id|_ga|yclid|msclkid)$/i;

/** Canonical form of a URL so the same page always maps to the same source id. */
export function normalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return input.trim();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (/^(old|new|np|m|i)\.reddit\.com$/.test(u.hostname) || u.hostname === "reddit.com") u.hostname = "www.reddit.com";
  if (u.hostname === "twitter.com" || u.hostname === "www.twitter.com" || u.hostname === "mobile.twitter.com" || u.hostname === "www.x.com") {
    u.hostname = "x.com";
  }
  if (u.hostname === "arxiv.org" || u.hostname === "www.arxiv.org" || u.hostname === "export.arxiv.org") {
    u.hostname = "arxiv.org";
    const m = u.pathname.match(/^\/(?:abs|pdf)\/([^/]+?)(?:v\d+)?(?:\.pdf)?$/);
    if (m) u.pathname = `/abs/${m[1]}`;
  }
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  if (u.hostname === "x.com") u.search = "";
  if (u.hostname === "www.reddit.com") {
    // A thread is the same source with or without the title slug in its URL.
    const thread = /^\/r\/([^/]+)\/comments\/([a-z0-9]+)(?:\/[^/]*)?\/?$/i.exec(u.pathname);
    if (thread) u.pathname = `/r/${thread[1]}/comments/${thread[2]}`;
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  return u.toString();
}

/** Stable id derived from the normalized URL: the same URL gets the same id in every process. */
export function sourceId(url: string): string {
  const hex = createHash("sha1").update(normalizeUrl(url)).digest("hex");
  return "S" + BigInt("0x" + hex.slice(0, 10)).toString(36).padStart(7, "0").slice(-6);
}

const ALPHABET = "0123456789abcdefghijkmnpqrstuvwxyz";

export function shortId(prefix: string, len = 5): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return prefix + out;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function oneLine(text: string | undefined, max = 280): string {
  if (!text) return "";
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isoDate(input: string | number | Date | undefined): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  const d = typeof input === "number" ? new Date(input < 1e12 ? input * 1000 : input) : new Date(input);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function daysAgoDate(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Folder-safe slug that keeps accented letters. */
export function slugify(text: string, max = 48): string {
  const slug = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return truncate(slug, max).replace(/…$/, "").replace(/-+$/, "") || "pesquisa";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Runs async jobs with a concurrency cap, keeping input order in the output. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function compactNumber(n: number | undefined): string {
  if (n === undefined) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
