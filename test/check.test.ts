import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "../src/core/types.ts";
import { computeStatus, nextActionText } from "../src/pipeline/phases.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { addFindings, addSources, checkOn, createSession, hitToSource, loadSession, updateMeta } from "../src/pipeline/session.ts";
import { registerTools } from "../src/tools/register.ts";

// The trust check (crosscheck, verification against primary sources, quotes checked by the
// server) is off unless the user asks for it in that research.

const hit = (url: string, source: SearchHit["source"]): SearchHit => ({ url, title: `Title of ${url}`, source, provider: "test" });

/** A session whose sub-question already meets its targets and has one key finding. `check` undefined = the default. */
async function ready(check?: boolean, depth: "standard" | "deep" = "standard") {
  const { meta } = await createSession({ question: "Teste da checagem de confiança", depth, deepRead: 0, ...(check === undefined ? {} : { check }) });
  await updateMeta(meta.id, (m) => {
    m.plan = { subquestions: [{ id: "Q1", question: "O que se diz?", layers: ["community"] }], at: new Date().toISOString() };
  });
  const sources = [
    hitToSource(hit("https://www.reddit.com/r/x/comments/aaa111/t", "reddit"), "Q1"),
    hitToSource(hit("https://news.ycombinator.com/item?id=7", "hn"), "Q1"),
    hitToSource(hit("https://www.youtube.com/watch?v=abcdefghijk", "youtube"), "Q1"),
  ];
  await addSources(meta.id, sources);
  const [a, b, c] = sources.map((s) => s.id) as [string, string, string];
  await addFindings(
    meta.id,
    "Q1",
    [
      { text: "a thread elogia o projeto", kind: "opinion", sources: [a] },
      { text: "o HN aponta um limite de 20 mil triângulos", kind: "fact", sources: [b], key: true },
      { text: "o vídeo mostra o passo a passo", kind: "opinion", sources: [c] },
      { text: "a thread também cita um erro comum", kind: "opinion", sources: [a] },
    ],
    [],
  );
  return { id: meta.id, sources };
}

describe("trust check is opt-in", () => {
  it("starts every new research with the check off, unless it is asked for", async () => {
    expect((await createSession({ question: "pesquisa sem pedido de checagem" })).meta.check).toBe(false);
    expect((await createSession({ question: "pesquisa com a checagem pedida", check: true })).meta.check).toBe(true);
    expect((await createSession({ question: "pesquisa com check explicitamente falso", check: false })).meta.check).toBe(false);
  });

  it("skips crosscheck and verification when off, even in deep research with a key finding", async () => {
    for (const depth of ["standard", "deep"] as const) {
      const { id } = await ready(undefined, depth);
      const data = await loadSession(id);
      const status = computeStatus(data);
      expect(status.checking).toBe(false);
      expect(status.phase).toBe("report");
      expect(status.phases).toEqual(["plan", "collect", "report"]);
      const text = nextActionText(data, status);
      expect(text).toContain("fase 3/3 relatório");
      expect(text).toContain("checagem de confiança: desligada");
      expect(text).toContain("não passou por checagem de confiança");
      expect(text).not.toMatch(/trawl_crosscheck|trawl_verify/);
    }
  });

  it("goes through crosscheck and verification when the user asked for the check", async () => {
    const { id } = await ready(true);
    let data = await loadSession(id);
    let status = computeStatus(data);
    expect(status.checking).toBe(true);
    expect(status.phases).toEqual(["plan", "collect", "crosscheck", "verify", "report"]);
    expect(status.phase).toBe("crosscheck");
    expect(nextActionText(data, status)).toContain("fase 3/5 cruzamento");

    await updateMeta(id, (m) => {
      m.crosscheck = { conflicts: [], consensus: [], blindSpots: [], at: new Date().toISOString() };
    });
    data = await loadSession(id);
    status = computeStatus(data);
    expect(status.phase).toBe("verify");
    expect(nextActionText(data, status)).toContain("fase 4/5 verificação");
  });

  it("keeps the check on for researches saved before the option existed", async () => {
    const { id } = await ready(true);
    await updateMeta(id, (m) => {
      delete m.check;
    });
    const meta = (await loadSession(id)).meta;
    expect(checkOn(meta)).toBe(true);
    expect(computeStatus(await loadSession(id)).phase).toBe("crosscheck");
  });

  it("says in the report whether the check ran", async () => {
    const off = await ready();
    const on = await ready(true);
    const body = (id: string) => ({ title: "Relatório", summary: `A thread elogia [${id}].`, sections: [{ heading: "h", body: `Texto [${id}].` }] });
    const offMd = renderReport(await loadSession(off.id), body(off.sources[0]!.id)).md;
    expect(offMd).toContain("desligada nesta pesquisa");
    expect(offMd).not.toContain("verificados:");
    const onMd = renderReport(await loadSession(on.id), body(on.sources[0]!.id)).md;
    expect(onMd).toContain("Checagem de confiança (cruzamento e verificação na fonte original): ligada");
    expect(onMd).toContain("verificados: 0");
  });
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

describe("quotes follow the trust check", () => {
  function tools() {
    const handlers = new Map<string, Handler>();
    registerTools({ registerTool: (name: string, _cfg: unknown, h: Handler) => void handlers.set(name, h) } as unknown as McpServer);
    return handlers;
  }

  async function planned(check?: boolean) {
    const { meta } = await createSession({ question: "Citações seguem a checagem de confiança", depth: "quick", ...(check === undefined ? {} : { check }) });
    await updateMeta(meta.id, (m) => {
      m.plan = { subquestions: [{ id: "Q1", question: "Pergunta?", layers: ["community"] }], at: new Date().toISOString() };
    });
    return meta.id;
  }

  const keyFinding = (quotes?: Array<{ source: string; text: string }>) => ({
    session_id: "",
    subquestion: "Q1",
    gaps: [],
    findings: [{ text: "Achado marcado como chave", kind: "fact", sources: ["https://example.com/a"], key: true, ...(quotes ? { quotes } : {}) }],
  });

  it("does not ask for a quote on a key finding when the check is off, and ignores one that is sent", async () => {
    const id = await planned();
    const add = tools().get("trawl_add_findings")!;
    const plain = await add({ ...keyFinding(), session_id: id });
    expect(plain.isError).toBeUndefined();
    expect(plain.content[0]!.text).toContain("Registrados 1 achados");

    const withQuote = await add({ ...keyFinding([{ source: "https://example.com/a", text: "this exact sentence was never written anywhere" }]), session_id: id });
    expect(withQuote.isError).toBeUndefined();
    expect(withQuote.content[0]!.text).toContain("citações enviadas foram ignoradas");
    const stored = [...(await loadSession(id)).claims.values()];
    expect(stored.every((c) => !c.quotes?.length)).toBe(true);
  });

  it("still refuses a key finding without a quote when the user asked for the check", async () => {
    const id = await planned(true);
    const r = await tools().get("trawl_add_findings")!({ ...keyFinding(), session_id: id });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("achado-chave sem citação");
    expect((await loadSession(id)).claims.size).toBe(0);
  });

  it("tells the agent, in the session start, that the check is off by default", async () => {
    const start = await tools().get("trawl_start")!({ question: "Como funciona o padrão da checagem desligada?", depth: "quick", language: "pt-BR", check: false });
    expect(start.content[0]!.text).toContain("checagem de confiança: desligada");
  });
});
