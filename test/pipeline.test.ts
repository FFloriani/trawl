import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "../src/core/types.ts";
import { computeStatus, nextActionText } from "../src/pipeline/phases.ts";
import { findCitations, renderReport, writeReport } from "../src/pipeline/report.ts";
import {
  addFindings,
  addSources,
  addVerifications,
  createSession,
  hitToSource,
  listSessions,
  loadSession,
  updateMeta,
} from "../src/pipeline/session.ts";

const hit = (url: string, source: SearchHit["source"], extra: Partial<SearchHit> = {}): SearchHit => ({
  url,
  title: `Title of ${url}`,
  source,
  provider: "test",
  ...extra,
});

describe("research session lifecycle", () => {
  it("walks plan → collect → crosscheck → verify → report → done", async () => {
    // This research asks for the trust check, so it goes through verification before the report.
    const { meta } = await createSession({ question: "Qual o melhor servidor MCP de busca?", depth: "quick", check: true });
    let data = await loadSession(meta.id);
    expect(computeStatus(data).phase).toBe("plan");

    await updateMeta(meta.id, (m) => {
      m.plan = {
        subquestions: [
          { id: "Q1", question: "Quais existem?", layers: ["code"] },
          { id: "Q2", question: "O que usuários dizem?", layers: ["community"] },
        ],
        at: new Date().toISOString(),
      };
    });
    const sources = [
      hit("https://github.com/a/one", "github", { metrics: { stars: 900 } }),
      hit("https://github.com/b/two", "github"),
      hit("https://www.reddit.com/r/mcp/comments/aaa111/x", "reddit", { metrics: { score: 300, comments: 40 } }),
      hit("https://news.ycombinator.com/item?id=1", "hn", { metrics: { score: 120, comments: 10 } }),
    ].map((h) => hitToSource(h, "Q1"));
    await addSources(meta.id, sources);
    data = await loadSession(meta.id);
    expect(computeStatus(data).phase).toBe("collect");

    const [s1, s2, s3, s4] = sources.map((s) => s.id) as [string, string, string, string];
    await addFindings(meta.id, "Q1", [
      { text: "one tem 900 estrelas e push recente", kind: "fact", sources: [s1], key: true },
      { text: "two está sem atualização", kind: "fact", sources: [s2] },
    ], []);
    await addFindings(meta.id, "Q2", [
      { text: "usuários elogiam one", kind: "opinion", sources: [s3] },
      { text: "HN critica a latência", kind: "opinion", sources: [s4] },
    ], [{ text: "nada no X", layer: "community" }]);

    data = await loadSession(meta.id);
    let status = computeStatus(data);
    // quick skips crosscheck and goes straight to verifying the key claim
    expect(status.subs.every((s) => s.ok)).toBe(true);
    expect(status.phase).toBe("verify");
    expect(status.toVerify).toHaveLength(1);
    expect(nextActionText(data, status)).toContain(status.toVerify[0]!.id);

    await addVerifications(meta.id, [{ claim: status.toVerify[0]!.id, verdict: "confirmed", at: new Date().toISOString() }]);
    data = await loadSession(meta.id);
    status = computeStatus(data);
    expect(status.phase).toBe("report");

    const rendered = renderReport(data, {
      title: "Servidores MCP de busca",
      summary: `O mais usado é o one [${s1}], e a comunidade confirma [${s3}, ${s4}].`,
      sections: [{ heading: "Projetos", body: `Two parou [${s2}]. Título hostil: <script>alert(1)</script>` }],
    });
    expect(rendered.cited).toEqual([s1, s3, s4, s2]);
    expect(rendered.md).toContain("## O que a comunidade diz");
    expect(rendered.md).toContain("**Pode afirmar**");
    expect(rendered.html).not.toContain("<script>alert(1)</script>");
    expect(rendered.html).toContain("&lt;script&gt;");

    const paths = await writeReport(data, rendered, "Servidores MCP de busca");
    expect(await readFile(paths.md, "utf8")).toContain("# Servidores MCP de busca");
    await updateMeta(meta.id, (m) => {
      m.report = { md: paths.md, html: paths.html, at: new Date().toISOString() };
    });
    expect(computeStatus(await loadSession(meta.id)).phase).toBe("done");
    expect((await listSessions()).some((m) => m.id === meta.id)).toBe(true);
  });

  it("refuses a report that cites unknown ids", async () => {
    const { meta } = await createSession({ question: "teste de citação", depth: "quick" });
    const data = await loadSession(meta.id);
    expect(() =>
      renderReport(data, { title: "x", summary: "Afirmação inventada [Sabcdef].", sections: [{ heading: "h", body: "b" }] }),
    ).toThrow(/desconhecido/);
  });

  it("merges repeated source records instead of duplicating them", async () => {
    const { meta } = await createSession({ question: "merge de fontes", depth: "quick" });
    const a = hitToSource(hit("https://example.com/a", "web"), "Q1");
    await addSources(meta.id, [a]);
    await addSources(meta.id, [{ ...a, subquestions: ["Q2"], readAt: "2026-01-01T00:00:00.000Z" }]);
    const data = await loadSession(meta.id);
    expect(data.sources.size).toBe(1);
    expect(data.sources.get(a.id)?.subquestions.sort()).toEqual(["Q1", "Q2"]);
    expect(data.sources.get(a.id)?.readAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("finds grouped and malformed citations", () => {
    expect(findCitations("a [Sabc123, Sdef456] b [S12ab] c [x]")).toEqual(["Sabc123", "Sdef456", "S12ab"]);
  });
});
