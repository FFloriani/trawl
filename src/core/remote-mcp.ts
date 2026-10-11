import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "../config.ts";
import { log } from "./log.ts";
import { errMessage } from "./util.ts";

// Some sources are themselves public MCP servers (grep.app, DeepWiki). Trawl talks to
// them as an MCP client over Streamable HTTP and keeps one connection per server.

const clients = new Map<string, Promise<Client>>();

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "trawl", version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function clientFor(url: string): Promise<Client> {
  let c = clients.get(url);
  if (!c) {
    c = connect(url);
    clients.set(url, c);
    c.catch(() => clients.delete(url));
  }
  return c;
}

/** Calls a tool on a remote MCP server and returns its text. Reconnects once on failure. */
export async function callRemoteTool(url: string, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = await clientFor(url);
      const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
      const text = ((res.content ?? []) as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (res.isError) throw new Error(text || `${tool} falhou`);
      return text;
    } catch (err) {
      clients.delete(url);
      log.debug(`remote mcp ${url} ${tool} (tentativa ${attempt + 1}): ${errMessage(err)}`);
      if (attempt === 1) throw err;
    }
  }
  throw new Error("inalcançável");
}

export async function closeRemoteClients(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.allSettled(all.map(async (c) => (await c).close()));
}
