import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./config.ts";
import { registerPrompts, SERVER_INSTRUCTIONS } from "./prompts.ts";
import { registerTools } from "./tools/register.ts";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "trawl", title: "Trawl", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
  );
  registerTools(server);
  registerPrompts(server);
  return server;
}
