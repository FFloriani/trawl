import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserPath } from "../../src/core/browser.ts";

const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

let client: Client;

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  const out = text(r);
  if ((r as { isError?: boolean }).isError) throw new Error(`${name}: ${out}`);
  return out;
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  expect((r as { isError?: boolean }).isError).toBe(true);
  return text(r);
}

/** A run of consecutive words from the first quoted passage of a source, i.e. a real quote. */
function quoteFrom(collectOut: string, id: string): string {
  const section = collectOut.split(`#### [${id}]`)[1] ?? "";
  for (const line of section.split("\n")) {
    if (!line.startsWith("> ")) continue;
    const words = line.slice(2).replace(/^…\s*/, "").replace(/\s*…$/, "").split(/\s+/).filter(Boolean);
    if (words.length >= 8) return words.slice(0, 10).join(" ");
  }
  throw new Error(`sem trecho citável para ${id}`);
}

beforeAll(async () => {
  client = new Client({ name: "ss-live-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      // The tests must not open Docker on whoever runs them.
      env: { ...process.env, TRAWL_HOME: process.env.TRAWL_HOME!, TRAWL_LOG: "error", TRAWL_SEARXNG_AUTOSTART: "0" } as Record<string, string>,
    }),
  );
});

afterAll(async () => {
  await client?.close();
});

describe("Trawl over real MCP stdio", () => {
  it("negotiates a protocol the current clients accept and lists tools, prompts, resource", async () => {
    expect(client.getServerVersion()?.name).toBe("trawl");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        "trawl_add_findings",
        "trawl_add_sources",
        "trawl_ask_repo",
        "trawl_collect",
        "trawl_crosscheck",
        "trawl_doctor",
        "trawl_next",
        "trawl_plan",
        "trawl_radar",
        "trawl_read",
        "trawl_recall",
        "trawl_report",
        "trawl_search",
        "trawl_sessions",
        "trawl_start",
        "trawl_verify",
      ].sort(),
    );
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["comunidade", "pesquisa", "pesquisa_rapida"]);
    const method = await client.readResource({ uri: "trawl://metodo" });
    expect(JSON.stringify(method)).toContain("Método de pesquisa");
  });

  it("runs a full quick research end to end, checking every quote against the source", async () => {
    // The trust check is off by default; this research asks for it.
    const start = await call("trawl_start", { question: "Como desenvolvedores avaliam agentes de deep research open source?", depth: "quick", since_days: 365, check: true });
    const id = /Sessão criada: (tr-[0-9a-z]+)/.exec(start)?.[1];
    expect(id).toBeTruthy();
    expect(start).toContain("checagem de confiança: ligada");

    const plan = await call("trawl_plan", {
      session_id: id,
      subquestions: [
        { question: "Quais projetos open source de deep research existem e quão ativos estão?", layers: ["code"] },
        { question: "O que desenvolvedores comentam sobre eles?", layers: ["community"] },
      ],
    });
    expect(plan).toContain("trawl_collect");

    // One call: search, rank, read the best and return passages.
    const c1 = await call("trawl_collect", { session_id: id, subquestion: "Q1", queries: ["deep research agent", "open deep research"], sources: ["github"], limit: 5, read: 2 });
    expect(c1).toContain("Ranking único");
    const readIds = [...c1.matchAll(/^#### \[(S[0-9a-z]{6})\]/gm)].map((m) => m[1]!);
    const repoIds = [...c1.matchAll(/^\d+\. \[(S[0-9a-z]{6})\]/gm)].map((m) => m[1]!);
    expect(readIds.length).toBeGreaterThanOrEqual(1);
    expect(repoIds.length).toBeGreaterThanOrEqual(2);
    const quote = quoteFrom(c1, readIds[0]!);

    // A key finding with an invented quote is refused, and nothing is saved.
    const refused = await callError("trawl_add_findings", {
      session_id: id,
      subquestion: "Q1",
      findings: [
        { text: "Projeto A é o mais estrelado", kind: "fact", sources: [readIds[0]], key: true, quotes: [{ source: readIds[0], text: "this exact sentence was never written in that repository readme" }] },
      ],
    });
    expect(refused).toContain("não conferem");
    // A key finding without any quote is refused too.
    await callError("trawl_add_findings", { session_id: id, subquestion: "Q1", findings: [{ text: "Projeto A é ativo", kind: "fact", sources: [readIds[0]], key: true }] });

    const added = await call("trawl_add_findings", {
      session_id: id,
      subquestion: "Q1",
      findings: [
        { text: "Projeto A é o mais estrelado da busca", kind: "fact", sources: [readIds[0]], key: true, quotes: [{ source: readIds[0], text: quote }] },
        { text: "Projeto B também aparece com push recente", kind: "fact", sources: [repoIds.find((r) => r !== readIds[0])] },
      ],
    });
    expect(added).toContain("1 no texto da fonte");

    const s2 = await call("trawl_search", { session_id: id, subquestion: "Q2", query: "deep research agent", sources: ["hn"], limit: 4 });
    const hnIds = [...s2.matchAll(/\[(S[0-9a-z]{6})\]/g)].map((m) => m[1]!);
    expect(hnIds.length).toBeGreaterThanOrEqual(2);
    await call("trawl_add_findings", {
      session_id: id,
      subquestion: "Q2",
      findings: [
        { text: "Discussão no HN sobre um agente de deep research", kind: "opinion", sources: [hnIds[0]] },
        { text: "Outra discussão no HN", kind: "opinion", sources: [hnIds[1]] },
      ],
    });

    const next = await call("trawl_next", { session_id: id });
    expect(next).toContain("3/4 verificação");
    const claimId = /- (C[0-9a-z]{5}) \[fact, chave\]/.exec(next)?.[1];
    expect(claimId).toBeTruthy();

    const early = await call("trawl_report", { session_id: id, title: "Cedo demais", summary: "Resumo provisório com bastante texto.", sections: [{ heading: "x", body: "y" }] });
    expect(early).toContain("Ainda não é hora do relatório");

    // "confirmed" without a quote is refused; with the real quote it is accepted.
    await callError("trawl_verify", { session_id: id, results: [{ claim_id: claimId, verdict: "confirmed" }] });
    await call("trawl_verify", { session_id: id, results: [{ claim_id: claimId, verdict: "confirmed", quote, quote_source: readIds[0] }] });

    const report = await call("trawl_report", {
      session_id: id,
      title: "Agentes de deep research open source",
      summary: `Há projetos ativos [${readIds[0]}] e a comunidade discute o tema [${hnIds[0]}].`,
      sections: [{ heading: "Projetos ativos dominam a lista", body: `Veja [${repoIds[0]}, ${repoIds[1]}] e [${hnIds[1]}].` }],
    });
    expect(report).toContain("report.md");
    expect(await call("trawl_next", { session_id: id })).toContain("concluída");

    // The next research on the theme starts from what this one found.
    expect(await call("trawl_recall", { query: "deep research agentes" })).toContain(id!);
  });

  it("keeps the trust check off unless asked: no quotes needed, no crosscheck, no verification", async () => {
    const start = await call("trawl_start", { question: "Pesquisa sem checagem de confiança, só coleta e relatório", depth: "quick" });
    const id = /Sessão criada: (tr-[0-9a-z]+)/.exec(start)?.[1];
    expect(start).toContain("checagem de confiança: desligada");
    await call("trawl_plan", {
      session_id: id,
      subquestions: [
        { question: "Primeira pergunta de teste?", layers: ["code"] },
        { question: "Segunda pergunta de teste?", layers: ["community"] },
      ],
    });
    // A key finding with no quote is fine when the check is off; a quote sent anyway is ignored.
    const added = await call("trawl_add_findings", {
      session_id: id,
      subquestion: "Q1",
      findings: [
        { text: "Achado marcado como chave, sem citação", kind: "fact", sources: ["https://example.com/a"], key: true },
        { text: "Achado com citação inventada que deve ser ignorada", kind: "fact", sources: ["https://example.com/a"], key: true, quotes: [{ source: "https://example.com/a", text: "this exact sentence was never written anywhere at all" }] },
      ],
    });
    expect(added).toContain("Registrados 2 achados");
    expect(added).toContain("citações enviadas foram ignoradas");
    await call("trawl_add_findings", {
      session_id: id,
      subquestion: "Q2",
      findings: [
        { text: "Achado um da segunda pergunta", kind: "opinion", sources: ["https://example.org/b"] },
        { text: "Achado dois da segunda pergunta", kind: "opinion", sources: ["https://example.org/b"] },
      ],
    });
    const next = await call("trawl_next", { session_id: id });
    expect(next).toContain("relatório");
    expect(next).not.toMatch(/cruzamento|verificação/i);
  });

  it.skipIf(!browserPath())("reads a page that builds its text with JavaScript, and Steam announcements as official", async () => {
    const page = await call("trawl_read", { url: "https://aion2.plaync.com/ko-kr/board/update/view?articleId=6ab2d738a279104f7d9d5d5b", max_chars: 1000 });
    expect(page).toContain("navegador sem interface");
    expect(page).toMatch(/Trecho 0–\d+ de (\d{4,})/);
    const steam = await call("trawl_read", { url: "https://store.steampowered.com/news/app/3393110", max_chars: 1000 });
    expect(steam).toContain("Anúncios oficiais na Steam");
  });

  it("keeps a radar and reports only new items on the next run", async () => {
    const created = await call("trawl_radar", { action: "create", name: "teste radar", queries: ["sqlite"], sources: ["hn"], first_window_days: 30 });
    expect(created).toContain("linha de base");
    const again = await call("trawl_radar", { action: "run", name: "teste radar" });
    expect(again).toMatch(/\d+ novos de \d+/);
    // Live data can bring a post published minutes ago; what must never happen is a repeat.
    const urls = (text: string) => [...text.matchAll(/^ {3}(https:\/\/\S+)$/gm)].map((m) => m[1]);
    for (const url of urls(again)) expect(created).not.toContain(url);
    expect(await call("trawl_radar", { action: "list" })).toContain("teste radar");
    await call("trawl_radar", { action: "delete", name: "teste radar" });
  });
});
