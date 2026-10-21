import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "../src/core/types.ts";
import type { CollectResult } from "../src/pipeline/collect.ts";
import { computeStatus, nextActionText, readingStatus } from "../src/pipeline/phases.ts";
import { renderReport } from "../src/pipeline/report.ts";
import {
  addFindings,
  addReading,
  addSources,
  createSession,
  foldReading,
  hitToSource,
  loadReading,
  loadSession,
  saveSourceText,
  updateMeta,
} from "../src/pipeline/session.ts";
import { collectText } from "../src/tools/format.ts";
import { registerTools } from "../src/tools/register.ts";

const hit = (url: string, source: SearchHit["source"], extra: Partial<SearchHit> = {}): SearchHit => ({
  url,
  title: `Title of ${url}`,
  source,
  provider: "test",
  ...extra,
});

const AT = "2026-10-12T00:00:00.000Z";

/** A standard session whose sub-question already meets its targets: only the reading is missing. */
async function readyForReading(opts: { depth?: "quick" | "standard" | "deep"; deepRead?: number } = {}) {
  const { meta } = await createSession({ question: "Como fazer roupa em camadas no Roblox?", depth: opts.depth ?? "standard", deepRead: opts.deepRead });
  await updateMeta(meta.id, (m) => {
    m.plan = { subquestions: [{ id: "Q1", question: "Como se faz?", layers: ["community"] }], at: AT };
  });
  const yt = hitToSource(hit("https://www.youtube.com/watch?v=abcdefghijk", "youtube", { title: "Layered clothing tutorial", author: "Zander" }), "Q1", {
    score: 80,
    tier: "post",
  });
  const rd = hitToSource(hit("https://www.reddit.com/r/robloxgamedev/comments/aaa111/x", "reddit", { metrics: { score: 50, comments: 12 } }), "Q1", {
    score: 60,
    tier: "fórum",
  });
  const hn = hitToSource(hit("https://news.ycombinator.com/item?id=42", "hn"), "Q1", { score: 40, tier: "fórum" });
  await addSources(meta.id, [yt, rd, hn]);
  await addFindings(
    meta.id,
    "Q1",
    [
      { text: "o vídeo mostra o caminho", kind: "opinion", sources: [yt.id] },
      { text: "a thread confirma", kind: "opinion", sources: [rd.id] },
      { text: "o HN discorda de um detalhe", kind: "opinion", sources: [hn.id] },
    ],
    [],
  );
  return { id: meta.id, yt, rd, hn };
}

describe("reading ledger", () => {
  it("counts windows once and passages as a capped sample", () => {
    const st = foldReading([
      { source: "Sabc123", total: 40_000, shown: 1_800, at: AT },
      { source: "Sabc123", total: 40_000, from: 0, to: 20_000, at: AT },
      { source: "Sabc123", total: 40_000, from: 10_000, to: 30_000, at: AT },
      { source: "Sdef456", total: 10_000, shown: 9_000, at: AT },
    ]);
    const a = st.get("Sabc123")!;
    expect(a.read).toBe(30_000);
    expect(a.seen).toBe(31_800);
    expect(a.deep).toBe(true);
    const b = st.get("Sdef456")!;
    expect(b.read).toBe(0);
    expect(b.seen).toBe(4_000);
    expect(b.deep).toBe(false);
  });

  it("asks for at most 60% of a text, and never more than 30 thousand characters", () => {
    const small = foldReading([{ source: "Ssmall1", total: 10_000, from: 0, to: 5_900, at: AT }]).get("Ssmall1")!;
    expect(small.deep).toBe(false);
    const ok = foldReading([{ source: "Ssmall1", total: 10_000, from: 0, to: 6_000, at: AT }]).get("Ssmall1")!;
    expect(ok.deep).toBe(true);
    const huge = foldReading([{ source: "Shuge11", total: 300_000, from: 0, to: 30_000, at: AT }]).get("Shuge11")!;
    expect(huge.deep).toBe(true);
  });

  it("keeps the search score on the source even when a later record has none", async () => {
    const { meta } = await createSession({ question: "score persistido na fonte", depth: "quick" });
    const s = hitToSource(hit("https://example.com/a", "web"), "Q1", { score: 77, tier: "documentação" });
    await addSources(meta.id, [s]);
    await addSources(meta.id, [{ ...s, score: undefined, tier: undefined, provider: "trawl_read", readAt: AT }]);
    const got = (await loadSession(meta.id)).sources.get(s.id)!;
    expect(got.score).toBe(77);
    expect(got.tier).toBe("documentação");
  });
});

describe("deep reading phase", () => {
  it("asks for the long source before the crosscheck, and moves on once it is read", async () => {
    const { id, yt } = await readyForReading();
    await addReading(id, [{ source: yt.id, total: 40_000, shown: 1_800 }]);

    let data = await loadSession(id);
    let status = computeStatus(data);
    expect(status.phase).toBe("read");
    expect(status.reading.pending.map((c) => c.id)).toEqual([yt.id]);
    expect(status.reading.pending[0]!.subquestion).toBe("Q1");

    const text = nextActionText(data, status);
    expect(text).toContain("leitura funda");
    expect(text).toContain(`source_id="${yt.id}"`);
    expect(text).toContain(`subquestion="Q1"`);
    expect(text).toContain("[mm:ss]");

    await addReading(id, [{ source: yt.id, total: 40_000, from: 0, to: 40_000 }]);
    data = await loadSession(id);
    status = computeStatus(data);
    expect(status.phase).toBe("crosscheck");
    expect(status.reading.deep).toBe(1);
    expect(nextActionText(data, status)).toContain("1 a fundo");
  });

  it("lets a gap that names the source waive the reading", async () => {
    const { id, yt } = await readyForReading();
    await addReading(id, [{ source: yt.id, total: 40_000, shown: 1_800 }]);
    expect(computeStatus(await loadSession(id)).phase).toBe("read");
    await addFindings(id, "Q1", [], [{ text: `[${yt.id}] não lida: repete a documentação oficial` }]);
    expect(computeStatus(await loadSession(id)).phase).toBe("crosscheck");
  });

  it("skips the phase in quick research and when deep_read is 0", async () => {
    const quick = await readyForReading({ depth: "quick" });
    await addReading(quick.id, [{ source: quick.yt.id, total: 40_000, shown: 1_800 }]);
    expect(computeStatus(await loadSession(quick.id)).phase).not.toBe("read");

    const off = await readyForReading({ deepRead: 0 });
    await addReading(off.id, [{ source: off.yt.id, total: 40_000, shown: 1_800 }]);
    expect(computeStatus(await loadSession(off.id)).phase).toBe("crosscheck");
  });

  it("ignores sources shorter than the minimum and keeps the best ones when capped", async () => {
    const { id, yt, rd, hn } = await readyForReading({ deepRead: 1 });
    await addReading(id, [
      { source: yt.id, total: 40_000, shown: 1_800 },
      { source: rd.id, total: 60_000, shown: 2_400 },
      { source: hn.id, total: 3_000, shown: 1_800 },
    ]);
    const rs = readingStatus(await loadSession(id), 1);
    // The video outranks the thread: higher search score and a kind of source that repays reading.
    expect(rs.required.map((c) => c.id)).toEqual([yt.id]);
    const all = readingStatus(await loadSession(id), 10);
    expect(all.required.map((c) => c.id)).not.toContain(hn.id);
    expect(all.stored).toBe(3);
  });

  it("does not take the session back to reading after the report exists, but offers it at the end", async () => {
    const { id, yt } = await readyForReading();
    await addReading(id, [{ source: yt.id, total: 40_000, shown: 1_800 }]);
    await updateMeta(id, (m) => {
      m.crosscheck = { conflicts: [], consensus: [], blindSpots: [], at: AT };
      m.report = { md: "r.md", html: "r.html", at: AT };
    });
    const data = await loadSession(id);
    const status = computeStatus(data);
    expect(status.phase).toBe("done");
    expect(nextActionText(data, status)).toContain("Leitura funda disponível");
    expect(nextActionText(data, status)).toContain(`source_id="${yt.id}"`);
  });

  it("does not count a fetch made only to check a quote as a source to study", async () => {
    const { id, yt } = await readyForReading();
    await saveSourceText(id, yt.id, "x".repeat(40_000));
    await addSources(id, [{ ...yt, readAt: AT }]);
    const data = await loadSession(id);
    expect(data.reading.has(yt.id)).toBe(false);
    expect(computeStatus(data).phase).toBe("crosscheck");
  });

  it("falls back to the stored text size for sessions from before the ledger", async () => {
    const { id, yt } = await readyForReading();
    await updateMeta(id, (m) => {
      delete m.readingLedger;
    });
    await saveSourceText(id, yt.id, "y".repeat(8_000));
    await addSources(id, [{ ...yt, readAt: AT }]);
    const st = (await loadSession(id)).reading.get(yt.id)!;
    expect(st).toMatchObject({ total: 8_000, read: 0, seen: 0, deep: false });
  });
});

describe("choosing what to study", () => {
  it("sends a huge reference page to the end of the list and filters by kind of source", async () => {
    const { meta } = await createSession({ question: "ordem de leitura de fontes longas", depth: "deep" });
    const video = hitToSource(hit("https://www.youtube.com/watch?v=aaaaaaaaaaa", "youtube", { title: "Tutorial" }), "Q1");
    const terms = hitToSource(hit("https://example.com/terms", "web", { title: "Terms of Use" }), "Q1");
    const guide = hitToSource(hit("https://example.com/guide", "web", { title: "Guide" }), "Q1");
    await addSources(meta.id, [video, terms, guide]);
    await addReading(meta.id, [
      { source: video.id, total: 25_000, shown: 1_800 },
      { source: terms.id, total: 250_000, shown: 1_800 },
      { source: guide.id, total: 30_000, shown: 1_800 },
    ]);
    const data = await loadSession(meta.id);
    expect(readingStatus(data, 3).required.map((c) => c.id)).toEqual([guide.id, video.id, terms.id]);
    expect(readingStatus(data, 3, ["youtube"]).required.map((c) => c.id)).toEqual([video.id]);
    expect(readingStatus(data, 3, ["youtube"]).stored).toBe(3);
  });

  it("lists a long set one line per source, with the steps said once", async () => {
    const { id } = await readyForReading();
    const extra = Array.from({ length: 9 }, (_, i) => hitToSource(hit(`https://example.com/guide-${i}`, "web", { title: `Guia ${i}` }), "Q1"));
    await addSources(id, extra);
    await addReading(id, extra.map((s) => ({ source: s.id, total: 10_000, shown: 1_800 })));
    const data = await loadSession(id);
    const text = nextActionText(data, computeStatus(data, 12));
    expect(text).toContain("Para cada fonte da lista");
    expect(text).toMatch(new RegExp(`- \\[${extra[0]!.id}\\] web · Guia 0 · 10[.,]000 car\\. · visto 18% · Q1`));
    expect(text).not.toContain("### [");
  });
});

describe("what the reports and the collection say", () => {
  it("states how much was read in depth instead of calling everything read", async () => {
    const { id, yt, rd } = await readyForReading();
    await addReading(id, [
      { source: yt.id, total: 40_000, shown: 1_800 },
      { source: yt.id, total: 40_000, from: 0, to: 40_000 },
      { source: rd.id, total: 9_000, shown: 1_500 },
    ]);
    const rendered = renderReport(await loadSession(id), {
      title: "Roupa em camadas",
      summary: `O vídeo ensina o caminho [${yt.id}] e a thread concorda [${rd.id}].`,
      sections: [{ heading: "Caminho", body: `Passo a passo em vídeo [${yt.id}].` }],
    });
    expect(rendered.md).toContain("## Material lido a fundo");
    expect(rendered.md).toContain("lidas a fundo pelo modelo: 1");
    expect(rendered.md).toContain("só em trechos: 1");
    expect(rendered.md).not.toContain("lidas na íntegra");
  });

  it("shows how much of each long source reached the model", () => {
    const res = {
      ranked: [],
      dropped: { count: 0, examples: [] },
      tally: {},
      discussions: [],
      ms: 1000,
      reads: [
        {
          ranked: { hit: hit("https://www.youtube.com/watch?v=abcdefghijk", "youtube"), tier: "post", parts: { relevance: 1, trust: 0.5 }, score: 70 },
          id: "Sabc1234",
          title: "Tutorial longo",
          passages: ["um trecho"],
          chars: 40_000,
          shown: 1_800,
        },
        {
          ranked: { hit: hit("https://example.com/curta", "web"), tier: "site", parts: { relevance: 1, trust: 0.5 }, score: 60 },
          id: "Sdef5678",
          title: "Página curta",
          passages: ["outro trecho"],
          chars: 2_000,
          shown: 1_800,
        },
      ],
    } as unknown as CollectResult;
    const text = collectText(res, 15, ["roupa em camadas"], []);
    expect(text).toMatch(/40[.,]000 caracteres no texto guardado, 1[.,]800 mostrados \(5%\)/);
    expect(text).toContain("Fontes longas vistas só em trechos: [Sabc1234]");
    expect(text).not.toContain("[Sdef5678] 2");
  });
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

describe("trawl_read inside a session", () => {
  it("serves a stored source in windows and records what the model read", async () => {
    const { meta } = await createSession({ question: "leitura em janelas de uma fonte guardada", depth: "standard" });
    const src = hitToSource(hit("https://www.youtube.com/watch?v=zzzzzzzzzzz", "youtube", { title: "Vídeo longo" }), "Q1");
    await addSources(meta.id, [{ ...src, readAt: AT }]);
    const body = Array.from({ length: 400 }, (_, i) => `[${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}] linha ${i} com bastante texto para ocupar espaço na janela`).join("\n");
    await saveSourceText(meta.id, src.id, `# Vídeo longo\n\n${body}`);
    await addReading(meta.id, [{ source: src.id, total: body.length, shown: 1_800 }]);

    const handlers = new Map<string, Handler>();
    registerTools({ registerTool: (name: string, _cfg: unknown, h: Handler) => void handlers.set(name, h) } as unknown as McpServer);
    const read = handlers.get("trawl_read")!;

    const first = await read({ session_id: meta.id, source_id: src.id, max_chars: 12_000, offset: 0 });
    expect(first.isError).toBeUndefined();
    const t1 = first.content[0]!.text;
    expect(t1).toContain("[00:00] linha 0");
    expect(t1).toMatch(/Leitura nesta sessão: 12[.,]000 de/);
    expect(t1).not.toContain("leitura funda desta fonte concluída");

    const second = await read({ session_id: meta.id, source_id: src.id, max_chars: 12_000, offset: 12_000 });
    expect(second.content[0]!.text).toContain("leitura funda desta fonte concluída");

    const st = (await loadReading(meta.id)).get(src.id)!;
    expect(st.read).toBe(24_000);
    expect(st.deep).toBe(true);
  });
});
