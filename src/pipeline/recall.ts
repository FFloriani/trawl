import { queryTerms, tokenize } from "../core/text.ts";
import { mapLimit } from "../core/util.ts";
import { listSessions, loadSession, type ClaimRecord, type SessionData, type SourceRecord, type VerificationRecord } from "./session.ts";

// What earlier research already found. Every finding of every saved session is a document;
// a BM25 score picks the ones about the query, so a new research starts from what is known.

export interface RecallHit {
  score: number;
  /** Share of the query terms the finding contains. */
  coverage: number;
  sessionId: string;
  question: string;
  date: string;
  claim: ClaimRecord;
  verification?: VerificationRecord;
  sources: SourceRecord[];
  report?: string;
}

interface Doc {
  data: SessionData;
  claim: ClaimRecord;
  tokens: string[];
}

export function scoreDocs<T extends { tokens: string[] }>(docs: T[], terms: string[]): Array<{ doc: T; score: number; coverage: number }> {
  if (!docs.length || !terms.length) return [];
  const avg = docs.reduce((n, d) => n + d.tokens.length, 0) / docs.length || 1;
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.tokens.includes(t)).length]));
  return docs.map((doc) => {
    let score = 0;
    let hit = 0;
    for (const t of terms) {
      const tf = doc.tokens.filter((x) => x === t).length;
      if (!tf) continue;
      hit++;
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * doc.tokens.length) / avg));
    }
    return { doc, score, coverage: hit / terms.length };
  });
}

export async function recall(query: string, opts: { limit?: number; exclude?: string; minCoverage?: number } = {}): Promise<RecallHit[]> {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const metas = (await listSessions(1000)).filter((m) => m.id !== opts.exclude);
  const sessions = (await mapLimit(metas, 6, (m) => loadSession(m.id).catch(() => undefined))).filter((d): d is SessionData => Boolean(d));

  const docs: Doc[] = [];
  for (const data of sessions) {
    for (const claim of data.claims.values()) {
      // The session question adds context ("which research was this?") at a lower weight.
      const text = `${claim.text} ${claim.text} ${(claim.quotes ?? []).map((q) => q.text).join(" ")} ${data.meta.question}`;
      docs.push({ data, claim, tokens: tokenize(text) });
    }
  }
  const minCoverage = opts.minCoverage ?? (terms.length >= 3 ? 0.5 : 1);
  const verdictBoost = (v?: VerificationRecord) => (v?.verdict === "confirmed" || v?.verdict === "corrected" ? 1.25 : v?.verdict === "false" ? 0.8 : 1);

  const perSession = new Map<string, number>();
  const out: RecallHit[] = [];
  for (const { doc, score, coverage } of scoreDocs(docs, terms)
    .filter((x) => x.coverage >= minCoverage && x.score > 0)
    .map((x) => ({ ...x, score: x.score * verdictBoost(x.doc.data.verifications.get(x.doc.claim.id)) }))
    .sort((a, b) => b.score - a.score)) {
    const sid = doc.data.meta.id;
    // A few per research, so one big session does not drown the others.
    if ((perSession.get(sid) ?? 0) >= 4) continue;
    perSession.set(sid, (perSession.get(sid) ?? 0) + 1);
    out.push({
      score,
      coverage,
      sessionId: sid,
      question: doc.data.meta.question,
      date: doc.claim.addedAt.slice(0, 10),
      claim: doc.claim,
      verification: doc.data.verifications.get(doc.claim.id),
      sources: doc.claim.sources.map((id) => doc.data.sources.get(id)).filter((s): s is SourceRecord => Boolean(s)),
      report: doc.data.meta.report?.md,
    });
    if (out.length >= (opts.limit ?? 12)) break;
  }
  return out;
}

const VERDICT: Record<string, string> = { confirmed: "confirmado", corrected: "corrigido", unverified: "sem prova", false: "FALSO" };

export function recallLines(hits: RecallHit[]): string[] {
  return hits.map((h) => {
    const v = h.verification;
    const text = v?.verdict === "corrected" && v.correctedText ? v.correctedText : h.claim.text;
    const src = h.sources
      .slice(0, 2)
      .map((s) => s.url)
      .join(" ; ");
    return `- ${h.date} · ${h.sessionId} · [${h.claim.kind}${v ? `, ${VERDICT[v.verdict]}` : ""}] ${text}${src ? `\n  fontes: ${src}` : ""}`;
  });
}
