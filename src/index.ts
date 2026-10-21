#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { config, VERSION } from "./config.ts";
import { availabilityAll, fanout } from "./connectors/index.ts";
import { browserPath } from "./core/browser.ts";
import { markServerProcess } from "./core/searxng.ts";
import { queryTerms } from "./core/text.ts";
import { listRadars, runDueRadars, runRadar } from "./pipeline/radar.ts";
import { rankHits } from "./pipeline/rank.ts";
import { readUrl } from "./connectors/reader.ts";
import { log } from "./core/log.ts";
import { closeRemoteClients } from "./core/remote-mcp.ts";
import { SOURCE_NAMES, type SourceName } from "./core/types.ts";
import { errMessage, sourceId } from "./core/util.ts";
import { createServer } from "./server.ts";
import { formatRead, rankedLine, reportLine } from "./tools/format.ts";

const HELP = `Trawl ${VERSION}: servidor MCP de pesquisa profunda

Uso:
  trawl                 inicia o servidor MCP (stdio), é o que a IDE chama
  trawl doctor          mostra quais fontes estão ativas
  trawl search "termos" [--sources reddit,hn] [--days 30] [--limit 5]
  trawl read <url>      lê uma fonte em Markdown
  trawl radar list      mostra os radares de novidades
  trawl radar run <nome> | --due | --all
                                  roda radares e grava o resumo do que é novo
  trawl --version

Chaves e ajustes: ${config.home}\\.env (veja .env.example)`;

async function serve(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`Trawl ${VERSION} pronto (stdio)`);
  // Nothing is started here. With TRAWL_SEARXNG_AUTOSTART=1 the local SearXNG (and Docker) is
  // brought up only when an agent uses web search, from the web connector's availability check.
  markServerProcess();
  let closing = false;
  // stdin close, SIGINT and SIGTERM can all fire; close once. Calling process.exit() while
  // sockets or pipes are still closing trips a libuv assertion on Windows, so everything is
  // closed (MCP transport, remote MCP clients, fetch's keep-alive sockets) and the event loop
  // drains on its own. The unref'd timer only fires if something still holds the process.
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const dispatcher = (globalThis as Record<symbol, { close?: () => Promise<void> } | undefined>)[Symbol.for("undici.globalDispatcher.1")];
    void Promise.allSettled([server.close(), closeRemoteClients(), dispatcher?.close?.()]).finally(() => {
      process.stdin.destroy();
      setTimeout(() => process.exit(0), 3000).unref();
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      sources: { type: "string" },
      days: { type: "string" },
      limit: { type: "string" },
      due: { type: "boolean" },
      all: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;

  if (values.version) return void console.log(VERSION);
  if (values.help) return void console.log(HELP);

  switch (cmd) {
    case undefined:
    case "serve":
      return serve();
    case "doctor": {
      for (const r of await availabilityAll()) {
        console.log(`${r.ok ? "[ok]  " : "[off] "}${r.name.padEnd(14)} ${r.mode}${r.note ? ` (${r.note})` : ""}`);
        if (r.enable) console.log(`       → ${r.enable}`);
      }
      console.log(`${browserPath() ? "[ok]  " : "[off] "}${"js-pages".padEnd(14)} ${browserPath() ?? "sem Chrome/Edge (TRAWL_BROWSER)"}`);
      console.log(`\nDados: ${config.home} · pesquisas: ${config.researchDir}`);
      return;
    }
    case "search": {
      const query = rest.join(" ");
      if (!query) throw new Error('informe os termos: search "termos"');
      const sources = (values.sources?.split(",").map((s) => s.trim()) ?? ["reddit", "hn", "github"]) as SourceName[];
      const bad = sources.filter((s) => !SOURCE_NAMES.includes(s));
      if (bad.length) throw new Error(`fontes desconhecidas: ${bad.join(", ")} (válidas: ${SOURCE_NAMES.join(", ")})`);
      const res = await fanout({
        query,
        sources,
        limit: values.limit ? Number(values.limit) : 5,
        sinceDays: values.days ? Number(values.days) : undefined,
      });
      console.log(reportLine(res.report) + "\n");
      const ranked = rankHits(res.hits, { terms: queryTerms(query), sinceDays: values.days ? Number(values.days) : undefined });
      console.log(ranked.map((r, i) => rankedLine(r, i + 1)).join("\n"));
      return;
    }
    case "radar": {
      const [sub, name] = rest;
      if (sub === "list") {
        for (const r of await listRadars()) {
          console.log(`${r.name} (${r.slug}) · a cada ${r.intervalHours} h · última: ${r.lastRun ? `${r.lastRun.at} · ${r.lastRun.newCount} novos · ${r.lastRun.digest}` : "nunca"}`);
        }
        return;
      }
      if (sub === "run") {
        let runs;
        if (name) runs = [await runRadar(name)];
        else if (values.all) {
          // One after another: radars share the same rate-limited sources.
          runs = [];
          for (const r of await listRadars()) runs.push(await runRadar(r.slug));
        } else runs = await runDueRadars();
        if (!runs.length) console.log("Nenhum radar vencido.");
        for (const r of runs) console.log(`${r.radar.name}: ${r.fresh.length} novos de ${r.total} → ${r.digest}${r.errors.length ? ` (falhas: ${r.errors.join("; ")})` : ""}`);
        return;
      }
      throw new Error("uso: radar list | radar run <nome> | radar run --due | radar run --all");
    }
    case "read": {
      const url = rest[0];
      if (!url) throw new Error("informe a URL: read <url>");
      const r = await readUrl(url);
      console.log(formatRead(r, sourceId(r.url), 0, 20000));
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

const cliMode = process.argv.slice(2).some((a) => !["serve"].includes(a));
main()
  .then(async () => {
    // CLI commands close remote MCP connections so the process can end; the server keeps them.
    if (cliMode) await closeRemoteClients();
  })
  .catch((err: unknown) => {
    console.error(`Erro: ${errMessage(err)}`);
    process.exit(1);
  });
