import { readUrl } from "../connectors/reader.ts";
import type { ReadResult } from "../core/types.ts";
import { closestPassage, quoteInText } from "../core/text.ts";
import { normalizeUrl, sourceId } from "../core/util.ts";
import { addReading, addSources, loadSourceText, saveSourceText, type Quote, type SourceRecord } from "./session.ts";

// The server, not the model, decides whether a quote is real: it compares the quote word for
// word with the text it read from the source itself. A model that paraphrases, translates or
// invents a sentence gets the claim refused, with the closest real sentence to fix it.

const READ_TIMEOUT_MS = 40_000;

export async function readWithTimeout(url: string, ms = READ_TIMEOUT_MS): Promise<ReadResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readUrl(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`leitura passou de ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the server keeps of a read: title on top, so a quote of the headline also counts. */
export function storedText(r: ReadResult): string {
  return `# ${r.title}\n\n${r.content}`;
}

/**
 * Saves a read into the session: the text for quote checks and the source marked as read.
 * `ledger` also opens its line in the reading ledger (what of the text reached the model); a
 * fetch made only to check a quote leaves it off, so it does not become a deep-reading target.
 */
export async function keepRead(sessionId: string, r: ReadResult, originalUrl?: string, subquestion?: string, ledger = true): Promise<string> {
  const id = sourceId(r.url);
  const at = new Date().toISOString();
  const base: SourceRecord = {
    id,
    url: normalizeUrl(r.url),
    title: r.title || r.url,
    source: r.source,
    provider: "trawl_read",
    published: r.published,
    author: r.author,
    metrics: r.metrics,
    subquestions: subquestion ? [subquestion] : [],
    addedAt: at,
    readAt: at,
  };
  const records = [base];
  await saveSourceText(sessionId, id, storedText(r));
  // The original URL may differ from the final one after redirects; keep both resolvable.
  if (originalUrl && sourceId(originalUrl) !== id) {
    const alias = sourceId(originalUrl);
    records.push({ ...base, id: alias, url: normalizeUrl(originalUrl) });
    await saveSourceText(sessionId, alias, storedText(r));
  }
  await addSources(sessionId, records);
  if (ledger) await addReading(sessionId, records.map((s) => ({ source: s.id, total: r.content.length })));
  return id;
}

/**
 * Rebuilds a read from what the session stored, so a long source can be served in windows
 * without fetching it again (and the windows always cut the same text).
 */
export async function loadStoredRead(sessionId: string, source: SourceRecord): Promise<ReadResult | undefined> {
  const stored = await loadSourceText(sessionId, source.id);
  if (!stored) return undefined;
  return {
    url: source.url,
    title: source.title,
    source: source.source,
    published: source.published,
    author: source.author,
    metrics: source.metrics,
    // storedText() puts the title on top, so a quote of the headline also counts.
    content: stored.replace(/^# [^\n]*\n\n/, ""),
    note: source.readAt ? `Texto guardado na sessão (lido em ${source.readAt.slice(0, 10)}).` : undefined,
  };
}

export type QuoteStatus =
  | { ok: true; quote: Quote }
  | { ok: false; source: string; text: string; reason: string; closest?: string };

/**
 * Checks one quote against one session source. Order: the stored text of a read; the search
 * excerpt; otherwise the server reads the source now and keeps the text for next time.
 */
export async function checkQuote(sessionId: string, source: SourceRecord, quoteText: string): Promise<QuoteStatus> {
  const text = quoteText.trim();
  const fail = (reason: string, closest?: string): QuoteStatus => ({ ok: false, source: source.id, text, reason, closest });

  const excerpt = [source.title, source.snippet].filter(Boolean).join("\n");
  let full = await loadSourceText(sessionId, source.id);
  if (full) {
    const r = quoteInText(full, text);
    if (r.ok) return { ok: true, quote: { source: source.id, text, checked: "text" } };
    if (excerpt && quoteInText(excerpt, text).ok) return { ok: true, quote: { source: source.id, text, checked: "snippet" } };
    return fail(r.reason ?? "a frase não aparece na fonte", closestPassage(full, text));
  }
  const fromExcerpt = excerpt ? quoteInText(excerpt, text) : undefined;
  if (fromExcerpt?.ok) return { ok: true, quote: { source: source.id, text, checked: "snippet" } };
  if (fromExcerpt?.reason?.startsWith("citação curta") || fromExcerpt?.reason?.startsWith("cada parte")) return fail(fromExcerpt.reason);

  try {
    const r = await readWithTimeout(source.url);
    await keepRead(sessionId, r, source.url, undefined, false);
    full = storedText(r);
  } catch {
    // Cannot read it (login wall, JavaScript-only page, timeout): accepted but labelled, and a
    // "confirmed" verdict still needs a source the server can read.
    return { ok: true, quote: { source: source.id, text, checked: "unreadable" } };
  }
  const r = quoteInText(full, text);
  if (r.ok) return { ok: true, quote: { source: source.id, text, checked: "text" } };
  return fail(r.reason ?? "a frase não aparece na fonte", closestPassage(full, text));
}

export function quoteFailureText(f: Extract<QuoteStatus, { ok: false }>): string {
  return [
    `- [${f.source}] "${f.text.length > 160 ? f.text.slice(0, 160) + "…" : f.text}": ${f.reason}.`,
    f.closest ? `  Frase mais parecida na fonte: "${f.closest}"` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
