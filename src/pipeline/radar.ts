import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { CONNECTORS, fanout } from "../connectors/index.ts";
import type { SourceName } from "../core/types.ts";
import { queryTerms } from "../core/text.ts";
import { compactNumber, mapLimit, normalizeUrl, oneLine, slugify } from "../core/util.ts";
import { rankHits, type Ranked } from "./rank.ts";

// A radar is a saved search that runs again on a schedule and reports only what is new since
// the last run. State lives in ~/.trawl/radar/<slug>/: radar.json (definition and last
// run), seen.json (every URL already shown) and runs/<date>.md (one digest per run).

export interface Radar {
  name: string;
  slug: string;
  queries: string[];
  sources: SourceName[];
  intervalHours: number;
  /** Window of the first run; later runs look back to the previous run. */
  firstWindowDays: number;
  officialDomains?: string[];
  forums?: string[];
  createdAt: string;
  lastRun?: { at: string; newCount: number; total: number; digest: string; baseline: boolean };
}

export interface RadarRun {
  radar: Radar;
  fresh: Ranked[];
  total: number;
  windowDays: number;
  digest: string;
  baseline: boolean;
  errors: string[];
}

export const radarHome = () => join(config.home, "radar");

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export interface RadarInput {
  name: string;
  queries: string[];
  sources: SourceName[];
  intervalHours?: number;
  firstWindowDays?: number;
  officialDomains?: string[];
  forums?: string[];
}

export async function saveRadar(input: RadarInput): Promise<Radar> {
  const slug = slugify(input.name, 40);
  const dir = join(radarHome(), slug);
  await mkdir(join(dir, "runs"), { recursive: true });
  const prev = await readJson<Radar>(join(dir, "radar.json"));
  const radar: Radar = {
    name: input.name.trim(),
    slug,
    queries: [...new Set(input.queries.map((q) => q.trim()).filter(Boolean))],
    sources: [...new Set(input.sources)],
    intervalHours: input.intervalHours ?? 24,
    firstWindowDays: input.firstWindowDays ?? 7,
    officialDomains: input.officialDomains,
    forums: input.forums,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    lastRun: prev?.lastRun,
  };
  await writeJsonAtomic(join(dir, "radar.json"), radar);
  return radar;
}

export async function listRadars(): Promise<Radar[]> {
  let names: string[] = [];
  try {
    names = await readdir(radarHome());
  } catch {
    return [];
  }
  const radars = await Promise.all(names.map((n) => readJson<Radar>(join(radarHome(), n, "radar.json"))));
  return radars.filter((r): r is Radar => Boolean(r)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRadar(nameOrSlug: string): Promise<Radar> {
  const slug = slugify(nameOrSlug, 40);
  const r = await readJson<Radar>(join(radarHome(), slug, "radar.json"));
  if (!r) throw new Error(`radar "${nameOrSlug}" não existe (trawl_radar action=list mostra os que existem)`);
  return r;
}

export async function deleteRadar(nameOrSlug: string): Promise<void> {
  const r = await getRadar(nameOrSlug);
  await rm(join(radarHome(), r.slug), { recursive: true, force: true });
}

export function isDue(r: Radar, now = Date.now()): boolean {
  if (!r.lastRun) return true;
  // 10 minutes of slack so a daily task scheduled at the same hour never skips a day.
  return now - Date.parse(r.lastRun.at) >= r.intervalHours * 3_600_000 - 600_000;
}

/** Days to look back: since the previous run (plus a day of overlap), or the first window. */
export function windowDays(r: Radar, now = Date.now()): number {
  if (!r.lastRun) return r.firstWindowDays;
  return Math.max(1, Math.ceil((now - Date.parse(r.lastRun.at)) / 86_400_000) + 1);
}

/**
 * Ranked hits never shown before and, after the first run, published since the previous run
 * (one day of overlap for late indexing). An older post that only now made the top results
 * is not news; undated hits count as new the first time they appear.
 */
export function onlyNew(ranked: Ranked[], seen: Record<string, string>, since?: number): Ranked[] {
  return ranked.filter((r) => {
    if (seen[normalizeUrl(r.hit.url)]) return false;
    if (since === undefined || !r.hit.published) return true;
    const t = Date.parse(r.hit.published);
    return Number.isNaN(t) || t >= since - 86_400_000;
  });
}

export function digestMarkdown(run: Omit<RadarRun, "digest">, at: Date): string {
  const r = run.radar;
  const lines = [
    `# Radar: ${r.name} (${at.toISOString().slice(0, 16).replace("T", " ")} UTC)`,
    "",
    `Consultas: ${r.queries.map((q) => `"${q}"`).join(", ")} · fontes: ${r.sources.join(", ")} · janela: últimos ${run.windowDays} dias`,
    run.baseline
      ? `Primeira execução (linha de base): ${run.fresh.length} itens. Nas próximas, só aparece o que for novo.`
      : `${run.fresh.length} novos de ${run.total} encontrados.`,
    ...run.errors.map((e) => `Falha: ${e}`),
    "",
  ];
  run.fresh.forEach((x, i) => {
    const h = x.hit;
    const m = h.metrics ?? {};
    const metrics = [
      m.score !== undefined ? `▲${compactNumber(m.score)}` : "",
      m.likes !== undefined ? `♥${compactNumber(m.likes)}` : "",
      m.stars !== undefined ? `★${compactNumber(m.stars)}` : "",
      m.comments !== undefined ? `${compactNumber(m.comments)} coment.` : "",
      m.views !== undefined ? `${compactNumber(m.views)} views` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `${i + 1}. **[${oneLine(h.title, 140).replace(/[[\]]/g, "")}](${h.url})** · ${x.score} · ${x.tier} · ${h.source}${h.published ? ` · ${h.published.slice(0, 10)}` : ""}${metrics ? ` · ${metrics}` : ""}`,
    );
    if (h.snippet) lines.push(`   ${oneLine(h.snippet, 240)}`);
  });
  return lines.join("\n") + "\n";
}

export async function runRadar(nameOrSlug: string, now = new Date()): Promise<RadarRun> {
  const radar = await getRadar(nameOrSlug);
  const dir = join(radarHome(), radar.slug);
  const days = windowDays(radar, now.getTime());
  // Sources switched off on this machine are skipped and reported, not retried every run.
  const states = await Promise.all(
    radar.sources.map(async (s) => [s, (s === "forums" && radar.forums?.length) || (await CONNECTORS[s].availability()).ok] as const),
  );
  const sources = states.filter(([, ok]) => ok).map(([s]) => s);
  const off = states.filter(([, ok]) => !ok).map(([s]) => s);
  const runs = await mapLimit(radar.queries, 3, (query) =>
    fanout({ query, sources, limit: 15, sinceDays: days, forums: radar.forums, timeoutMs: 60_000 }),
  );
  const errors = [...(off.length ? [`desligadas nesta máquina: ${off.join(", ")}`] : []), ...new Set(runs.flatMap((r) => Object.entries(r.report).filter(([, v]) => v?.error).map(([k, v]) => `${k}: ${oneLine(v!.error, 160)}`)))];
  const byUrl = new Map<string, (typeof runs)[number]["hits"][number]>();
  for (const h of runs.flatMap((r) => r.hits)) {
    const key = normalizeUrl(h.url);
    if (!byUrl.has(key)) byUrl.set(key, { ...h, url: key });
  }
  const ranked = rankHits([...byUrl.values()], { terms: queryTerms(...radar.queries), termSets: radar.queries.map((q) => queryTerms(q)), sinceDays: days, officialDomains: radar.officialDomains, now: now.getTime() });

  const seenFile = join(dir, "seen.json");
  const seen = (await readJson<Record<string, string>>(seenFile)) ?? {};
  const baseline = !radar.lastRun;
  const fresh = onlyNew(ranked, seen, radar.lastRun ? Date.parse(radar.lastRun.at) : undefined);
  for (const r of ranked) seen[normalizeUrl(r.hit.url)] ??= now.toISOString();
  await writeJsonAtomic(seenFile, seen);

  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const digest = join(dir, "runs", `${stamp}.md`);
  const partial = { radar, fresh, total: ranked.length, windowDays: days, baseline, errors };
  await writeFile(digest, digestMarkdown(partial, now));
  radar.lastRun = { at: now.toISOString(), newCount: fresh.length, total: ranked.length, digest, baseline };
  await writeJsonAtomic(join(dir, "radar.json"), radar);
  return { ...partial, digest };
}

/** Runs every radar whose interval has passed (what a scheduled task calls). */
export async function runDueRadars(now = new Date()): Promise<RadarRun[]> {
  const due = (await listRadars()).filter((r) => isDue(r, now.getTime()));
  const out: RadarRun[] = [];
  for (const r of due) out.push(await runRadar(r.slug, now));
  return out;
}
