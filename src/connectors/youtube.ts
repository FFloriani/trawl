import { getJson, request, TTL } from "../core/http.ts";
import type { Connector, ReadResult, SearchHit, SearchQuery } from "../core/types.ts";
import { decodeEntities, errMessage, isoDate, oneLine, truncate } from "../core/util.ts";

// YouTube search through the public results page (ytInitialData), no key.
// Transcripts: the web player's caption URLs now demand an anti-bot (PO) token. The public
// innertube player endpoint, asked as the Android app (the method of the widely used
// jdepoix/youtube-transcript-api), still returns caption tracks that do not. When YouTube marks
// a track as needing the token (&exp=xpe) we stop and say so: we never generate or forge tokens.

const HEADERS = { "accept-language": "en-US,en;q=0.9", cookie: "CONSENT=YES+1; SOCS=CAI" };

// Upload-date filters of the results page ("sp" parameter).
function uploadFilter(days?: number): string | undefined {
  if (!days) return undefined;
  if (days <= 1) return "EgIIAg==";
  if (days <= 7) return "EgIIAw==";
  if (days <= 31) return "EgIIBA==";
  if (days <= 366) return "EgIIBQ==";
  return undefined;
}

export function extractJsonVar(html: string, name: string): unknown {
  let marker = html.indexOf(`${name} = {`);
  if (marker < 0) marker = html.indexOf(`window["${name}"] = {`);
  if (marker < 0) return undefined;
  const start = html.indexOf("{", marker);
  // Walk braces (skipping strings) to find the end of the object literal.
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** "2w ago", "3 weeks ago", "Streamed 5 days ago" → approximate date. */
export function relativeToDate(text: string | undefined, now = Date.now()): string | undefined {
  if (!text) return undefined;
  // Longer units first: "mo" (month) must win over "m" (minute).
  const m = /(\d+)\s*(months?|mo|years?|yrs?|y|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s+ago\b/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const day = 86_400_000;
  const ms = unit.startsWith("mo")
    ? n * 30 * day
    : unit.startsWith("y")
      ? n * 365 * day
      : unit.startsWith("w")
        ? n * 7 * day
        : unit.startsWith("d")
          ? n * day
          : unit.startsWith("h")
            ? n * 3_600_000
            : unit === "m" || unit.startsWith("min")
              ? n * 60_000
              : n * 1000;
  return new Date(now - ms).toISOString();
}

export function parseCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /([\d.,]+)\s*([KMB])?/i.exec(text.replace(/\s/g, " "));
  if (!m) return undefined;
  const base = Number(m[1]!.replace(/,/g, ""));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Number.isFinite(base) ? Math.round(base * mult) : undefined;
}

interface VideoRenderer {
  videoId: string;
  title?: { runs?: Array<{ text: string }> };
  ownerText?: { runs?: Array<{ text: string }> };
  publishedTimeText?: { simpleText?: string };
  viewCountText?: { simpleText?: string };
  lengthText?: { simpleText?: string };
  detailedMetadataSnippets?: Array<{ snippetText?: { runs?: Array<{ text: string }> } }>;
}

export function findVideos(node: unknown, out: VideoRenderer[] = []): VideoRenderer[] {
  if (Array.isArray(node)) for (const v of node) findVideos(v, out);
  else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.videoRenderer && typeof obj.videoRenderer === "object") out.push(obj.videoRenderer as VideoRenderer);
    for (const v of Object.values(obj)) findVideos(v, out);
  }
  return out;
}

export const youtube: Connector = {
  name: "youtube",
  label: "YouTube",
  async availability() {
    return { ok: true, mode: "página de resultados pública, sem chave; trawl_read traz metadados, descrição e a transcrição quando o vídeo tem legenda" };
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const params = new URLSearchParams({ search_query: q.query });
    const sp = uploadFilter(q.sinceDays);
    if (sp) params.set("sp", sp);
    let data: unknown;
    let page = "";
    // YouTube now and then serves a variant without the data blob; one fresh retry fixes it.
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      const res = await request(`https://www.youtube.com/results?${params}`, {
        browser: true,
        headers: HEADERS,
        // No disk cache: pages are ~1.5 MB and a bad variant must not be replayed.
        cacheTtlMs: 0,
        signal: q.signal,
      });
      page = res.text;
      data = extractJsonVar(page, "ytInitialData");
    }
    if (!data) {
      if (/unusual traffic|google\.com\/sorry|captcha/i.test(page)) {
        throw new Error("YouTube pediu verificação anti-robô; espere alguns minutos antes de buscar de novo");
      }
      throw new Error("YouTube devolveu uma página sem os resultados (ytInitialData); tente de novo");
    }
    const seen = new Set<string>();
    return findVideos(data)
      .filter((v) => v.videoId && !seen.has(v.videoId) && seen.add(v.videoId))
      .slice(0, q.limit)
      .map((v) => {
        const title = v.title?.runs?.map((r) => r.text).join("") ?? v.videoId;
        const snippet = v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r) => r.text).join("");
        return {
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          title,
          snippet: oneLine(snippet, 300),
          source: "youtube" as const,
          provider: "youtube-web",
          published: relativeToDate(v.publishedTimeText?.simpleText),
          author: v.ownerText?.runs?.[0]?.text,
          metrics: { views: parseCount(v.viewCountText?.simpleText) },
          tags: [v.lengthText?.simpleText ?? "", v.publishedTimeText?.simpleText ? `data aproximada (${v.publishedTimeText.simpleText})` : ""].filter(Boolean),
        };
      });
  },
};

export function youtubeId(url: URL): string | undefined {
  if (url.hostname === "youtu.be") return url.pathname.slice(1) || undefined;
  if (url.pathname === "/watch") return url.searchParams.get("v") ?? undefined;
  return /^\/(?:shorts|live|embed)\/([\w-]{6,})/.exec(url.pathname)?.[1];
}

// Version string of the Android app sent to the player endpoint; bump if YouTube starts refusing it.
const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38" };

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  name?: { runs?: Array<{ text: string }>; simpleText?: string };
}

/** Manual captions before automatic ones; English, then Portuguese, then whatever exists. */
export function pickTrack(tracks: CaptionTrack[], langs = ["en", "pt", "pt-BR"]): CaptionTrack | undefined {
  const rank = (t: CaptionTrack) => {
    const li = langs.findIndex((l) => t.languageCode === l || t.languageCode?.startsWith(`${l}-`));
    return (t.kind === "asr" ? 100 : 0) + (li < 0 ? 50 : li);
  };
  return [...tracks].sort((a, b) => rank(a) - rank(b))[0];
}

/** Caption XML → "[mm:ss] text" paragraphs of about 30 seconds. */
export function transcriptFromXml(xml: string): string {
  const paras: string[] = [];
  let current: string[] = [];
  let paraStart = -1;
  for (const m of xml.matchAll(/<text start="([^"]*)" dur="[^"]*"[^>]*>([\s\S]*?)<\/text>/g)) {
    const start = Number(m[1]);
    // Caption text arrives entity-encoded twice ("&amp;#39;").
    const text = decodeEntities(decodeEntities(m[2] ?? "")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (paraStart < 0) paraStart = start;
    current.push(text);
    if (start - paraStart >= 30) {
      paras.push(`[${clock(paraStart)}] ${current.join(" ")}`);
      current = [];
      paraStart = -1;
    }
  }
  if (current.length) paras.push(`[${clock(Math.max(paraStart, 0))}] ${current.join(" ")}`);
  return paras.join("\n");
}

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type TranscriptResult = { ok: true; text: string; label: string } | { ok: false; reason: string };

async function fetchTranscript(id: string, watchHtml: string): Promise<TranscriptResult> {
  const key = /"INNERTUBE_API_KEY":\s*"([\w-]+)"/.exec(watchHtml)?.[1];
  if (!key) return { ok: false, reason: "página do vídeo sem a chave pública do player" };
  const player = await getJson<{
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
    playabilityStatus?: { status?: string; reason?: string };
  }>(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
    method: "POST",
    browser: true,
    json: { context: { client: ANDROID_CLIENT }, videoId: id },
    cacheTtlMs: TTL.page,
    retries: 1,
  });
  const track = pickTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  if (!track) {
    const status = player.playabilityStatus?.status;
    return { ok: false, reason: status && status !== "OK" ? `vídeo indisponível (${player.playabilityStatus?.reason ?? status})` : "o vídeo não tem legendas" };
  }
  if (track.baseUrl.includes("&exp=xpe")) {
    return { ok: false, reason: "o YouTube exigiu token anti-robô para esta legenda (não é gerado nem contornado)" };
  }
  const xml = await request(track.baseUrl.replace("&fmt=srv3", ""), { browser: true, cacheTtlMs: TTL.page });
  const text = transcriptFromXml(xml.text);
  if (!text) return { ok: false, reason: "legenda vazia" };
  const name = track.name?.simpleText ?? track.name?.runs?.map((r) => r.text).join("") ?? track.languageCode ?? "?";
  return { ok: true, text, label: `${name}${track.kind === "asr" ? ", automática" : ""}` };
}

export async function readYoutube(id: string): Promise<ReadResult> {
  const res = await request(`https://www.youtube.com/watch?v=${id}`, { browser: true, headers: HEADERS, cacheTtlMs: 0 });
  const player = extractJsonVar(res.text, "ytInitialPlayerResponse") as
    | {
        videoDetails?: { title?: string; author?: string; viewCount?: string; lengthSeconds?: string; shortDescription?: string; keywords?: string[] };
        microformat?: { playerMicroformatRenderer?: { publishDate?: string; category?: string } };
      }
    | undefined;
  const vd = player?.videoDetails;
  if (!vd) throw new Error("não foi possível ler o vídeo (página sem ytInitialPlayerResponse)");
  const mf = player?.microformat?.playerMicroformatRenderer;
  const secs = Number(vd.lengthSeconds ?? 0);
  let transcript: TranscriptResult;
  try {
    transcript = await fetchTranscript(id, res.text);
  } catch (err) {
    transcript = { ok: false, reason: errMessage(err) };
  }
  const autoNote = "Transcrição automática do YouTube: nomes próprios e termos técnicos podem vir errados.";
  return {
    url: `https://www.youtube.com/watch?v=${id}`,
    title: vd.title ?? id,
    source: "youtube",
    published: isoDate(mf?.publishDate),
    author: vd.author,
    metrics: { views: vd.viewCount ? Number(vd.viewCount) : undefined },
    note: transcript.ok
      ? transcript.label.includes("automática")
        ? autoNote
        : undefined
      : `Sem transcrição: ${transcript.reason}. Só metadados e descrição.`,
    content: [
      `Canal: ${vd.author ?? "?"} · ${vd.viewCount ?? "?"} visualizações · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} · publicado ${mf?.publishDate?.slice(0, 10) ?? "?"}`,
      vd.keywords?.length ? `Palavras-chave: ${vd.keywords.slice(0, 15).join(", ")}` : "",
      "",
      "## Descrição",
      truncate(vd.shortDescription ?? "", transcript.ok ? 2500 : 6000),
      ...(transcript.ok ? ["", `## Transcrição (${transcript.label})`, transcript.text] : []),
    ]
      .filter((l, i) => l !== "" || i > 1)
      .join("\n"),
  };
}
