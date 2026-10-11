import { fanout, type FanoutResult } from "../connectors/index.ts";
import type { SearchHit, SourceName } from "../core/types.ts";
import { fold, queryTerms, tokenize, topPassages } from "../core/text.ts";
import { errMessage, mapLimit, normalizeUrl, sourceId } from "../core/util.ts";
import { keepRead, readWithTimeout } from "./evidence.ts";
import { pickToRead, rankHits, type Ranked } from "./rank.ts";
import { addSources, hitToSource } from "./session.ts";

// One call does what used to take a dozen: every query variant on every source, one ranked
// list, the best sources read in full and only the passages that matter sent back. Everything
// found is registered in the session, and every read keeps its text for quote checks.

/** Web search is free on the local SearXNG and shallow at 8, so it always asks for more. */
export const WEB_LIMIT = 20;

/** Threads where people discuss; their comments are the community's real experience. */
const DISCUSSION_SOURCES = new Set<string>(["reddit", "hn", "forums", "github_discussions"]);

/** Platforms whose search matches loosely and returns posts about anything ("global" → esports). */
const NOISY_SOURCES = new Set<string>(["reddit", "reddit_comments", "x", "hn", "youtube"]);

const haystack = (h: SearchHit) => fold(`${h.title} ${h.snippet ?? ""} ${(h.tags ?? []).join(" ")} ${h.url}`);

/**
 * The subject word of each query: its term found in the most results ("aion" for
 * "aion 2 templar build", "아이온2" for the Korean variant). A post that has none of the
 * subject words of the queries that found it is about something else.
 */
export function queryAnchors(termSets: string[][], hits: SearchHit[]): Array<string | undefined> {
  const hays = hits.map(haystack);
  return termSets.map((terms) => {
    let best: { t: string; df: number } | undefined;
    for (const t of terms) {
      if (t.length < 2) continue;
      const df = hays.filter((h) => h.includes(t)).length;
      if (!best || df > best.df) best = { t, df };
    }
    return best?.t;
  });
}

export interface CollectOptions {
  queries: string[];
  sources: SourceName[];
  /** Results per source per query (web gets at least WEB_LIMIT). */
  limit: number;
  sinceDays?: number;
  /** How many top sources to read in full. */
  read: number;
  /** Extra reads of the most-commented discussions (Reddit, HN, forums), on top of `read`. */
  discussions?: number;
  passages: number;
  passageChars: number;
  /** Words the results should be about (the queries): drive the ranking. */
  terms: string[];
  /** Words for picking passages inside a read source; defaults to `terms`. */
  passageTerms?: string[];
  officialDomains?: string[];
  forums?: string[];
  sessionId?: string;
  subquestion?: string;
}

export interface SourceTally {
  count: number;
  ms: number;
  errors: string[];
  outOfWindow: number;
}

export interface CollectRead {
  ranked: Ranked;
  id: string;
  title: string;
  passages: string[];
  chars: number;
  /** Read because it is one of the most-commented discussions. */
  discussion?: boolean;
  note?: string;
  error?: string;
}

export interface CollectResult {
  ranked: Ranked[];
  /** Results dropped as off-topic, with a few examples of where they came from. */
  dropped: { count: number; examples: string[] };
  tally: Partial<Record<SourceName, SourceTally>>;
  reads: CollectRead[];
  /** Most-commented on-topic discussions, best first. */
  discussions: Ranked[];
  /** Second Reddit pass inside the subreddit most results came from. */
  subredditPass?: { subreddit: string; added: number };
  ms: number;
}

const subOf = (h: SearchHit) => h.tags?.find((t) => t.startsWith("r/"))?.slice(2);

/**
 * The subreddit most Reddit results came from, when it clearly dominates (5+ posts and 40%+):
 * a second search inside it finds threads that never say the topic's name in the title.
 */
export function dominantSubreddit(hits: SearchHit[]): string | undefined {
  const posts = hits.filter((h) => h.source === "reddit");
  const count = new Map<string, number>();
  for (const h of posts) {
    const s = subOf(h);
    if (s) count.set(s, (count.get(s) ?? 0) + 1);
  }
  const [top] = [...count].sort((a, b) => b[1] - a[1]);
  return top && top[1] >= 5 && top[1] / posts.length >= 0.4 ? top[0] : undefined;
}

/** "aion 2 templar build" inside r/Aion2 → "subreddit:Aion2 templar build" (the name is implied). */
export function subredditQuery(subreddit: string, query: string): string {
  const name = fold(subreddit).replace(/[^\p{L}\p{N}]/gu, "");
  const rest = query
    .split(/\s+/)
    .filter((t) => {
      const w = fold(t).replace(/[^\p{L}\p{N}]/gu, "");
      return !(w && name.includes(w) && (w.length >= 3 || /^\d+$/.test(w)));
    })
    .join(" ")
    .trim();
  return `subreddit:${subreddit} ${rest || query}`;
}

const commentsOf = (r: Ranked) => r.hit.metrics?.comments ?? r.hit.metrics?.replies ?? 0;

const words = (h: SearchHit) => new Set(tokenize(`${h.title} ${h.snippet ?? ""}`.replace(/https?:\/\/\S+/g, " ")));

/**
 * The subject's own vocabulary: words much more frequent (lift ≥ 1.3) in results that use the
 * specific query words ("templar", not the subject name "aion") than in all results. For a
 * Templar search that is tank, aggro, shield…; general game words (guide, player) drop out.
 * Lets a thread like "My experience tanking" count as on-subject without saying "templar".
 */
export function subjectVocabulary(hits: SearchHit[], termSets: string[][], anchors: Array<string | undefined>, max = 15): string[] {
  const queryWords = new Set(termSets.flat());
  const anchorSet = new Set(anchors.filter((a): a is string => Boolean(a)));
  // The specific word is the one repeated across the variants ("templar"), not a word only one
  // variant uses ("build", "skill"), which shows up everywhere and gives no contrast.
  const others = [...queryWords].filter((t) => !anchorSet.has(t));
  const repeated = others.filter((t) => termSets.filter((ts) => ts.includes(t)).length >= Math.ceil(termSets.length / 2));
  const specific = repeated.length ? repeated : others;
  if (!specific.length) return [];
  const docs = hits.map(words);
  const inS = docs.map((d) => specific.some((t) => d.has(t)));
  const n = docs.length;
  const nS = inS.filter(Boolean).length;
  if (nS < 5 || nS === n) return [];
  const dfAll = new Map<string, number>();
  const dfS = new Map<string, number>();
  docs.forEach((d, i) => {
    for (const t of d) {
      if (queryWords.has(t) || t.length <= 2 || /^\d+$/.test(t)) continue;
      dfAll.set(t, (dfAll.get(t) ?? 0) + 1);
      if (inS[i]) dfS.set(t, (dfS.get(t) ?? 0) + 1);
    }
  });
  const lift = (t: string, s: number) => s / nS / (dfAll.get(t)! / n);
  return [...dfS]
    .filter(([t, s]) => s >= 3 && lift(t, s) >= 1.3)
    .sort((a, b) => b[1] * lift(b[0], b[1]) - a[1] * lift(a[0], a[1]))
    .slice(0, max)
    .map(([t]) => t);
}

/**
 * How close a discussion is to the subject: 40% its match with the query words (relative to
 * the best hit), 60% how much of the subject's vocabulary it uses. The vocabulary part catches
 * threads that never repeat the query words.
 */
export function discussionTopic(r: Ranked, bestRelevance: number, vocab: string[] = []): number {
  const rel = bestRelevance > 0 ? r.parts.relevance / bestRelevance : 0;
  let share: number;
  if (vocab.length) {
    const w = words(r.hit);
    share = Math.min(1, vocab.filter((t) => w.has(t)).length / 3);
  } else {
    share = r.parts.shared === undefined ? 0.5 : Math.min(1, r.parts.shared / 3);
  }
  return 0.4 * rel + 0.6 * share;
}

/**
 * On-topic discussions with real conversation (3+ comments), by closeness × size of the
 * conversation. `matchedInside` = threads the platform itself returned for the specific words
 * inside the subject's own community (the subreddit pass): the words are in the post body even
 * when the title does not show them, so they count as on-subject.
 */
export function topDiscussions(ranked: Ranked[], vocab: string[] = [], matchedInside: ReadonlySet<string> = new Set()): Ranked[] {
  const best = Math.max(0, ...ranked.map((r) => r.parts.relevance));
  const topic = new Map(
    ranked.map((r) => {
      const t = discussionTopic(r, best, vocab);
      return [r, matchedInside.has(r.hit.url) ? Math.max(t, 0.55) : t];
    }),
  );
  const value = (r: Ranked) => topic.get(r)! * Math.log10(1 + commentsOf(r));
  return ranked
    .filter((r) => DISCUSSION_SOURCES.has(r.hit.source) && r.tier !== "suspeito" && commentsOf(r) >= 3 && topic.get(r)! >= 0.45)
    .sort((a, b) => value(b) - value(a));
}

function absorb(
  runs: FanoutResult[],
  tally: CollectResult["tally"],
  byUrl: Map<string, SearchHit>,
  queryHits: Map<string, number>,
  returnedBy: Map<string, Set<number>>,
): number {
  let added = 0;
  for (const [qi, run] of runs.entries()) {
    for (const [name, r] of Object.entries(run.report) as Array<[SourceName, NonNullable<(typeof run.report)[SourceName]>]>) {
      const t = (tally[name] ??= { count: 0, ms: 0, errors: [], outOfWindow: 0 });
      t.ms = Math.max(t.ms, r.ms);
      t.outOfWindow += r.outOfWindow ?? 0;
      if (r.error && !t.errors.includes(r.error)) t.errors.push(r.error);
    }
    for (const h of run.hits) {
      const key = normalizeUrl(h.url);
      const prev = byUrl.get(key);
      if (!prev) {
        byUrl.set(key, { ...h, url: key });
        added++;
      } else if (!prev.snippet && h.snippet) prev.snippet = h.snippet;
      queryHits.set(key, (queryHits.get(key) ?? 0) + 1);
      returnedBy.set(key, (returnedBy.get(key) ?? new Set()).add(qi));
    }
  }
  return added;
}

export async function collect(opts: CollectOptions): Promise<CollectResult> {
  const started = Date.now();
  const queries = [...new Set(opts.queries.map((q) => q.trim()).filter(Boolean))];
  const limits = { web: Math.max(opts.limit, WEB_LIMIT) };
  const runs = await mapLimit(queries, 3, (query) =>
    fanout({ query, sources: opts.sources, limit: opts.limit, limits, sinceDays: opts.sinceDays, forums: opts.forums, timeoutMs: 45_000 }),
  );

  const tally: CollectResult["tally"] = {};
  const byUrl = new Map<string, SearchHit>();
  const queryHits = new Map<string, number>();
  const returnedBy = new Map<string, Set<number>>();
  absorb(runs, tally, byUrl, queryHits, returnedBy);

  // When one subreddit holds most of the Reddit results, search inside it too.
  let subredditPass: CollectResult["subredditPass"];
  const matchedInside = new Set<string>();
  const sub = opts.sources.includes("reddit") && !queries.some((q) => /\bsubreddit:|(^|\s)r\//i.test(q)) ? dominantSubreddit([...byUrl.values()]) : undefined;
  if (sub) {
    const extra = await mapLimit(queries, 2, (query) =>
      fanout({ query: subredditQuery(sub, query), sources: ["reddit"], limit: opts.limit, sinceDays: opts.sinceDays, timeoutMs: 45_000 }),
    );
    subredditPass = { subreddit: sub, added: absorb(extra, tally, byUrl, queryHits, returnedBy) };
    for (const run of extra) for (const h of run.hits) matchedInside.add(normalizeUrl(h.url));
  }

  const termSets = queries.map((q) => queryTerms(q));
  const all = rankHits([...byUrl.values()], {
    terms: opts.terms,
    termSets,
    sinceDays: opts.sinceDays,
    officialDomains: opts.officialDomains,
    queryHits,
    queryCount: queries.length,
  });

  // Loose platforms bring posts about other things: kept only with the subject word of a query
  // that found them, or with a real share of the subject's vocabulary.
  const anchors = queryAnchors(termSets, all.map((r) => r.hit));
  const anchored = (h: SearchHit) => {
    const hay = haystack(h);
    return [...(returnedBy.get(h.url) ?? [])].some((qi) => anchors[qi] === undefined || hay.includes(anchors[qi]!));
  };
  const dropped: CollectResult["dropped"] = { count: 0, examples: [] };
  const ranked = all.filter((r) => {
    if (!NOISY_SOURCES.has(r.hit.source) || anchored(r.hit) || (r.parts.shared ?? 2) >= 2) return true;
    dropped.count++;
    const where = r.hit.tags?.find((t) => t.startsWith("r/")) ?? r.hit.source;
    if (dropped.examples.length < 4 && !dropped.examples.includes(where)) dropped.examples.push(where);
    return false;
  });
  const hits = ranked.map((r) => r.hit);
  for (const t of Object.values(tally)) t!.count = 0;
  for (const h of hits) (tally[h.source] ??= { count: 0, ms: 0, errors: [], outOfWindow: 0 }).count++;
  if (opts.sessionId && hits.length) await addSources(opts.sessionId, ranked.map((r) => hitToSource(r.hit, opts.subquestion)));

  // The best sources overall, plus the most-commented discussions they left out: comments are
  // where people describe what they actually did, which guides and search snippets miss.
  const discussions = topDiscussions(ranked, subjectVocabulary(hits, termSets, anchors), matchedInside);
  const toRead = pickToRead(ranked, opts.read).map((r) => ({ r, discussion: false }));
  const wantDiscussions = opts.discussions ?? (opts.sources.some((s) => DISCUSSION_SOURCES.has(s)) ? 2 : 0);
  for (const d of discussions) {
    if (toRead.filter((x) => x.discussion).length >= wantDiscussions) break;
    if (!toRead.some((x) => x.r === d)) toRead.push({ r: d, discussion: true });
  }

  const reads = await mapLimit(toRead, 4, async ({ r, discussion }): Promise<CollectRead> => {
    const id = sourceId(r.hit.url);
    try {
      const res = await readWithTimeout(r.hit.url, 35_000);
      if (opts.sessionId) await keepRead(opts.sessionId, res, r.hit.url, opts.subquestion);
      // Comments are short, so a discussion gets a couple more passages.
      const k = discussion || DISCUSSION_SOURCES.has(r.hit.source) ? opts.passages + 2 : opts.passages;
      return {
        ranked: r,
        id,
        title: res.title || r.hit.title,
        passages: topPassages(res.content, opts.passageTerms ?? opts.terms, k, opts.passageChars),
        chars: res.content.length,
        discussion,
        note: res.note,
      };
    } catch (err) {
      return { ranked: r, id, title: r.hit.title, passages: [], chars: 0, discussion, error: errMessage(err) };
    }
  });

  return { ranked, dropped, tally, reads, discussions, subredditPass, ms: Date.now() - started };
}
