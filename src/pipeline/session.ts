import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import type { LayerName } from "../connectors/index.ts";
import type { Metrics, SearchHit, SourceName } from "../core/types.ts";
import { normalizeUrl, shortId, slugify, sourceId, ymd } from "../core/util.ts";

// One folder per research session. session.json holds the small mutable state; the ledgers
// are append-only JSONL so parallel sub-agents (even in separate server processes) can write
// at the same time without clobbering each other.

export type Depth = "quick" | "standard" | "deep";
export type ClaimKind = "fact" | "stat" | "opinion" | "inference";
export type Verdict = "confirmed" | "corrected" | "unverified" | "false";

export interface SubQuestion {
  id: string;
  question: string;
  layers: LayerName[];
  /** Explicit sources when some of the layers' sources do not fit the subject. */
  sources?: SourceName[];
  why?: string;
}

export interface Conflict {
  topic: string;
  sides: string;
  stronger?: string;
  claims?: string[];
}

export interface Crosscheck {
  conflicts: Conflict[];
  consensus: string[];
  blindSpots: string[];
  strongestEvidence?: string;
  weakestEvidence?: string;
  at: string;
}

export interface SessionMeta {
  id: string;
  version: 1;
  question: string;
  goal?: string;
  audience?: string;
  language: string;
  depth: Depth;
  sinceDays?: number;
  createdAt: string;
  updatedAt: string;
  plan?: { subquestions: SubQuestion[]; at: string };
  /** Domains that speak for the subject itself (its site, docs, blog); ranked as "oficial". */
  officialDomains?: string[];
  /** Discourse forums about the subject, searched by the "forums" source. */
  forums?: string[];
  crosscheck?: Crosscheck;
  report?: { md: string; html: string; at: string; copies?: string[] };
}

export interface SourceRecord {
  id: string;
  url: string;
  title: string;
  source: SourceName | "page";
  provider: string;
  published?: string;
  author?: string;
  metrics?: Metrics;
  tags?: string[];
  snippet?: string;
  subquestions: string[];
  addedAt: string;
  readAt?: string;
}

/**
 * A literal excerpt that backs a claim. `checked` says how the server confirmed it:
 * "text" = found word for word in the source text it read; "snippet" = found in the search
 * result's own excerpt; "unreadable" = the server could not read the source to check.
 */
export interface Quote {
  source: string;
  text: string;
  checked: "text" | "snippet" | "unreadable";
}

export interface ClaimRecord {
  id: string;
  subquestion: string;
  text: string;
  kind: ClaimKind;
  sources: string[];
  key: boolean;
  quotes?: Quote[];
  addedAt: string;
}

export interface GapRecord {
  id: string;
  subquestion: string;
  text: string;
  layer?: LayerName;
  addedAt: string;
}

export interface VerificationRecord {
  claim: string;
  verdict: Verdict;
  note?: string;
  correctedText?: string;
  primarySource?: string;
  /** The excerpt of the primary source that proves the verdict, checked by the server. */
  quote?: Quote;
  at: string;
}

export interface SessionData {
  meta: SessionMeta;
  dir: string;
  sources: Map<string, SourceRecord>;
  claims: Map<string, ClaimRecord>;
  gaps: GapRecord[];
  verifications: Map<string, VerificationRecord>;
}

const FILES = {
  meta: "session.json",
  sources: "sources.jsonl",
  claims: "claims.jsonl",
  gaps: "gaps.jsonl",
  verifications: "verifications.jsonl",
  texts: "texts",
} as const;

const now = () => new Date().toISOString();

// ---------- locking (in-process) ----------

const chains = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

// ---------- paths ----------

const dirCache = new Map<string, string>();

export async function sessionDir(id: string): Promise<string> {
  const cached = dirCache.get(id);
  if (cached && existsSync(cached)) return cached;
  // "ss-" ids come from before the rename and keep working.
  if (!/^(tr|ss)-[0-9a-z]{4,12}$/.test(id)) throw new Error(`session_id inválido: ${id}`);
  let entries: string[] = [];
  try {
    entries = await readdir(config.researchDir);
  } catch {
    // no research yet
  }
  const name = entries.find((e) => e.endsWith(`--${id}`));
  if (!name) throw new Error(`sessão ${id} não encontrada em ${config.researchDir} (use trawl_sessions para listar)`);
  const dir = join(config.researchDir, name);
  dirCache.set(id, dir);
  return dir;
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

async function appendJsonl(file: string, records: unknown[]): Promise<void> {
  if (!records.length) return;
  // One write call per batch keeps lines whole even with concurrent appenders.
  await appendFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn line from a crash is skipped, not fatal
    }
  }
  return out;
}

// ---------- public API ----------

export interface CreateInput {
  question: string;
  goal?: string;
  audience?: string;
  language?: string;
  depth?: Depth;
  sinceDays?: number;
}

export async function createSession(input: CreateInput): Promise<{ meta: SessionMeta; dir: string }> {
  const id = shortId("tr-", 6);
  const dir = join(config.researchDir, `${ymd(new Date())}-${slugify(input.question, 40)}--${id}`);
  await mkdir(dir, { recursive: true });
  const meta: SessionMeta = {
    id,
    version: 1,
    question: input.question.trim(),
    goal: input.goal?.trim() || undefined,
    audience: input.audience?.trim() || undefined,
    language: input.language ?? "pt-BR",
    depth: input.depth ?? "standard",
    sinceDays: input.sinceDays,
    createdAt: now(),
    updatedAt: now(),
  };
  await writeJsonAtomic(join(dir, FILES.meta), meta);
  dirCache.set(id, dir);
  return { meta, dir };
}

export async function loadSession(id: string): Promise<SessionData> {
  const dir = await sessionDir(id);
  const meta = JSON.parse(await readFile(join(dir, FILES.meta), "utf8")) as SessionMeta;

  const sources = new Map<string, SourceRecord>();
  for (const r of await readJsonl<SourceRecord>(join(dir, FILES.sources))) {
    const prev = sources.get(r.id);
    if (!prev) {
      sources.set(r.id, { ...r, subquestions: [...new Set(r.subquestions ?? [])] });
      continue;
    }
    sources.set(r.id, {
      ...prev,
      ...stripUndefined(r),
      // A later record whose title is just the URL must not erase a real title.
      title: isUrlTitle(r) && !isUrlTitle(prev) ? prev.title : r.title,
      addedAt: prev.addedAt,
      subquestions: [...new Set([...prev.subquestions, ...(r.subquestions ?? [])])],
      readAt: r.readAt ?? prev.readAt,
    });
  }

  const claims = new Map<string, ClaimRecord>();
  for (const c of await readJsonl<ClaimRecord>(join(dir, FILES.claims))) claims.set(c.id, c);

  const verifications = new Map<string, VerificationRecord>();
  for (const v of await readJsonl<VerificationRecord>(join(dir, FILES.verifications))) verifications.set(v.claim, v);

  return { meta, dir, sources, claims, gaps: await readJsonl<GapRecord>(join(dir, FILES.gaps)), verifications };
}

function isUrlTitle(s: { title: string; url: string }): boolean {
  return !s.title || s.title === s.url || /^https?:\/\//.test(s.title);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function updateMeta(id: string, fn: (meta: SessionMeta) => SessionMeta | void): Promise<SessionMeta> {
  const dir = await sessionDir(id);
  return withLock(dir, async () => {
    const file = join(dir, FILES.meta);
    const meta = JSON.parse(await readFile(file, "utf8")) as SessionMeta;
    const next = fn(meta) ?? meta;
    next.updatedAt = now();
    await writeJsonAtomic(file, next);
    return next;
  });
}

export function hitToSource(hit: SearchHit, subquestion?: string): SourceRecord {
  return {
    id: sourceId(hit.url),
    url: normalizeUrl(hit.url),
    title: hit.title,
    source: hit.source,
    provider: hit.provider,
    published: hit.published,
    author: hit.author,
    metrics: hit.metrics,
    tags: hit.tags,
    snippet: hit.snippet,
    subquestions: subquestion ? [subquestion] : [],
    addedAt: now(),
  };
}

export async function addSources(id: string, records: SourceRecord[]): Promise<void> {
  const dir = await sessionDir(id);
  await appendJsonl(join(dir, FILES.sources), records);
}

export interface FindingInput {
  text: string;
  kind: ClaimKind;
  sources: string[];
  key?: boolean;
  quotes?: Quote[];
}

export interface GapInput {
  text: string;
  layer?: LayerName;
}

export async function addFindings(id: string, subquestion: string, findings: FindingInput[], gaps: GapInput[]): Promise<{ claims: ClaimRecord[]; gaps: GapRecord[] }> {
  const dir = await sessionDir(id);
  const claims = findings.map<ClaimRecord>((f) => ({
    id: shortId("C", 5),
    subquestion,
    text: f.text.trim(),
    kind: f.kind,
    sources: [...new Set(f.sources)],
    key: f.key ?? false,
    ...(f.quotes?.length ? { quotes: f.quotes } : {}),
    addedAt: now(),
  }));
  const gapRecords = gaps
    .filter((g) => g.text.trim())
    .map<GapRecord>((g) => ({ id: shortId("G", 4), subquestion, text: g.text.trim(), layer: g.layer, addedAt: now() }));
  await appendJsonl(join(dir, FILES.claims), claims);
  await appendJsonl(join(dir, FILES.gaps), gapRecords);
  return { claims, gaps: gapRecords };
}

export async function addVerifications(id: string, records: VerificationRecord[]): Promise<void> {
  const dir = await sessionDir(id);
  await appendJsonl(join(dir, FILES.verifications), records);
}

// Full text of every source read inside a session, so quotes can be checked against what the
// source really says. One file per source id; the id is validated to keep paths inside the folder.
const MAX_TEXT_CHARS = 400_000;

function textFile(dir: string, sid: string): string {
  if (!/^S[0-9a-z]{4,10}$/.test(sid)) throw new Error(`id de fonte inválido: ${sid}`);
  return join(dir, FILES.texts, `${sid}.md`);
}

export async function saveSourceText(id: string, sid: string, text: string): Promise<void> {
  const dir = await sessionDir(id);
  await mkdir(join(dir, FILES.texts), { recursive: true });
  await writeFile(textFile(dir, sid), text.slice(0, MAX_TEXT_CHARS));
}

export async function loadSourceText(id: string, sid: string): Promise<string | undefined> {
  const dir = await sessionDir(id);
  try {
    return await readFile(textFile(dir, sid), "utf8");
  } catch {
    return undefined;
  }
}

export async function listSessions(limit = 20): Promise<SessionMeta[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(config.researchDir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const name of entries.filter((e) => /--(tr|ss)-[0-9a-z]+$/.test(e)).sort().reverse()) {
    try {
      metas.push(JSON.parse(await readFile(join(config.researchDir, name, FILES.meta), "utf8")) as SessionMeta);
    } catch {
      // skip broken folders
    }
    if (metas.length >= limit) break;
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
