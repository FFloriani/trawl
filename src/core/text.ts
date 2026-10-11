// Text helpers shared by ranking, passage picking, quote checking and recall. Pure functions,
// no I/O, so they are easy to test.

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from has have how i in is it its of on or that the this to was were what when where which who why will with you your vs versus " +
    "o os as um uma uns umas de da do das dos em no na nos nas por para pra com sem que se ao aos à às é e ou mais menos como qual quais quando onde porque sobre entre seu sua seus suas ser são foi era está estão isso esta este essa esse " +
    "el la los las un una y en del al con por para es son lo " +
    // Common words that say nothing about a topic, so they never count as shared vocabulary.
    "not no nor so if than then there here they them their these those this that its it's im ive dont doesnt didnt cant wont isnt " +
    "all any some each few more most other such only own same too very just also really even still now new get got make made use using used " +
    "like one two first last well way thing things lot lots much many would could should may might must been being into out up down about over " +
    "after before again any every here http https www com org net html amp gt lt my me we our us he she his her him its yes yeah ok " +
    "don didn doesn isn wasn aren couldn wouldn shouldn haven hasn had has have back show see look know think want need going go come take say said " +
    "good great bad time day year today people anyone someone something anything everything thanks thank please " +
    "não nao mas muito muita também tambem já ja só so ele ela eles elas isso aqui ali ter tem têm fazer faz mesmo ainda bem então entao " +
    "pelo pela pelos pelas num numa este esta estes estas aquele aquela meu minha nosso nossa você voce vocês voces eu nós nos lhe"
  ).split(" "),
);

/** Lowercase, accent-free form used for every comparison. */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Light folding of plurals and English verb forms, so "issues" meets "issue", "tanking" meets
 * "tank" and "played" meets "play". Both sides of every comparison go through it.
 */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 5 && t.endsWith("ed") && !t.endsWith("eed")) return t.slice(0, -2);
  return t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
}

/** Content words (no stopwords, 2+ chars), folded and singularized. Duplicates kept. */
export function tokenize(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

/** Unique content words of several queries, ignoring search operators like `site:` or `-filter:`. */
export function queryTerms(...queries: Array<string | undefined>): string[] {
  const terms = new Set<string>();
  for (const q of queries) {
    if (!q) continue;
    const clean = q.replace(/(^|\s)-?[a-z_]+:\S+/gi, " ");
    for (const t of tokenize(clean)) terms.add(t);
  }
  return [...terms];
}

// ---------- literal quotes ----------

/**
 * Word skeleton of a text: markdown link targets and images dropped, accents, case and
 * punctuation ignored. Two texts with the same words in the same order share a skeleton,
 * whatever quotes, dashes or markdown they use.
 */
export function skeleton(text: string): string {
  return fold(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const MIN_QUOTE_WORDS = 5;

export interface QuoteCheck {
  ok: boolean;
  reason?: string;
}

/**
 * True when the quote appears word for word in the source. "..." / "…" / "[...]" split the quote
 * into pieces that must appear in that order; each piece needs 3+ words so an ellipsis cannot
 * stitch unrelated words together.
 */
export function quoteInText(source: string, quote: string): QuoteCheck {
  const pieces = quote
    .split(/\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…/)
    .map(skeleton)
    .filter(Boolean);
  const words = pieces.reduce((n, p) => n + p.split(" ").length, 0);
  if (words < MIN_QUOTE_WORDS) return { ok: false, reason: `citação curta demais (${words} palavras; mínimo ${MIN_QUOTE_WORDS})` };
  if (pieces.some((p) => p.split(" ").length < 3)) return { ok: false, reason: "cada parte entre reticências precisa de 3 palavras ou mais" };
  const hay = ` ${skeleton(source)} `;
  let from = 0;
  for (const p of pieces) {
    const at = hay.indexOf(` ${p} `, from);
    if (at < 0) return { ok: false, reason: "a frase não aparece na fonte" };
    from = at + p.length + 1;
  }
  return { ok: true };
}

/** Numbers written in a text ("40%", "1.5", "2026"), for checking that a stat's number is quoted. */
export function numbersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(",", ".")))];
}

// ---------- passages ----------

/** Splits a document into readable blocks: paragraphs, list items, comment lines. */
export function blocks(text: string, maxBlock = 900): string[] {
  const out: string[] = [];
  let pendingHeading = "";
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (/^#{1,6}\s/.test(p) && p.length < 160 && !p.includes("\n")) {
      pendingHeading = p;
      continue;
    }
    const pieces = p.length > maxBlock ? splitLong(p, maxBlock) : [p];
    for (const piece of pieces) {
      out.push(pendingHeading ? `${pendingHeading}\n${piece}` : piece);
      pendingHeading = "";
    }
  }
  if (pendingHeading) out.push(pendingHeading);
  return out;
}

function splitLong(p: string, maxBlock: number): string[] {
  const lines = p.split("\n").filter((l) => l.trim());
  const units = lines.length > 1 ? lines : p.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9"“])/);
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > maxBlock) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}${lines.length > 1 ? "\n" : " "}${u}` : u;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The k blocks that best match the terms, in document order, each cut to maxChars around its
 * first match. Scoring is BM25-like over the document's own blocks.
 */
export function topPassages(text: string, terms: string[], k = 3, maxChars = 600): string[] {
  const bs = blocks(text);
  if (!bs.length) return [];
  if (!terms.length) return [cut(bs[0]!, [], maxChars)];
  const toks = bs.map((b) => tokenize(b));
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, toks.filter((ts) => ts.includes(t)).length);
  const avg = toks.reduce((n, ts) => n + ts.length, 0) / toks.length || 1;
  const scored = bs.map((b, i) => {
    const ts = toks[i]!;
    let s = 0;
    for (const t of terms) {
      const tf = ts.filter((x) => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (bs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      s += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * ts.length) / avg));
    }
    return { i, b, s };
  });
  const best = scored
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .sort((a, b) => a.i - b.i);
  if (!best.length) return [cut(bs[0]!, [], maxChars)];
  return best.map((x) => cut(x.b, terms, maxChars));
}

function cut(block: string, terms: string[], maxChars: number): string {
  if (block.length <= maxChars) return block;
  const folded = fold(block);
  const first = terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0);
  const at = first.length ? Math.min(...first) : 0;
  const start = Math.max(0, Math.min(at - Math.floor(maxChars / 4), block.length - maxChars));
  // Start and end on word boundaries so a copied quote never begins mid-word.
  const s = start > 0 ? block.indexOf(" ", start) + 1 || start : 0;
  let e = Math.min(block.length, s + maxChars);
  if (e < block.length) e = block.lastIndexOf(" ", e) > s ? block.lastIndexOf(" ", e) : e;
  return `${s > 0 ? "… " : ""}${block.slice(s, e).trim()}${e < block.length ? " …" : ""}`;
}

/** The sentence or line of the source closest to a quote that failed, to help fix it. */
export function closestPassage(source: string, quote: string, maxChars = 300): string | undefined {
  const q = new Set(tokenize(quote));
  if (!q.size) return undefined;
  let best: { s: number; text: string } | undefined;
  for (const unit of source.split(/\n+|(?<=[.!?])\s+/)) {
    const ts = new Set(tokenize(unit));
    if (!ts.size) continue;
    let hit = 0;
    for (const t of q) if (ts.has(t)) hit++;
    const s = hit / q.size;
    if (s > 0 && (!best || s > best.s)) best = { s, text: unit.trim() };
  }
  return best && best.s >= 0.3 ? (best.text.length > maxChars ? best.text.slice(0, maxChars) + "…" : best.text) : undefined;
}
